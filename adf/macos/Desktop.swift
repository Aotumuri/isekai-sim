import AppKit

typealias Record = [String: Any]

@MainActor
final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let bridge = Bridge()
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1050, height: 720),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let projects = NSPopUpButton()
    private let roles = NSPopUpButton()
    private let experiments = NSPopUpButton()
    private let jobs = NSPopUpButton()
    private let status = NSTextField(labelWithString: "ADF に接続中")
    private let activity = NSTextField(labelWithString: "")
    private let chat = NSTextView()
    private let logs = NSTextView()
    private let issues = NSTextView()
    private let history = NSTextView()
    private let research = NSTextView()
    private let input = NSTextField()
    private var snapshot: Record = [:]
    private var events = [Record]()
    private var usage = ""
    private var selected: Int?
    private var cursor = 0
    private var closing = false
    private var timer: Timer?
    private var refreshing = false
    private var showingArtifact = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let menu = NSMenu()
        let appMenu = NSMenuItem()
        appMenu.submenu = NSMenu()
        appMenu.submenu?.addItem(withTitle: "ADF を終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(appMenu)
        NSApp.mainMenu = menu
        layout()
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        if CommandLine.arguments.contains("--smoke") {
            apply(["projects": [["id": 1, "name": "動作確認"]], "roles": [["name": "coordinator"]],
                   "sessions": [], "jobs": [], "templates": [], "events": [], "shutting_down": false])
            window.displayIfNeeded()
            precondition(window.isVisible && projects.numberOfItems == 1 && roles.numberOfItems == 1)
            print("AppKit desktop constructed and rendered")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            return
        }
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    private func layout() {
        window.title = "ADF — 自律開発"
        window.minSize = NSSize(width: 780, height: 540)
        window.delegate = self
        projects.target = self
        projects.action = #selector(selectProject)
        roles.target = self
        roles.action = #selector(renderChat)
        jobs.target = self
        jobs.action = #selector(loadLog)
        input.placeholderString = "エージェントへの指示"
        input.target = self
        input.action = #selector(send)
        let top = row([label("プロジェクト"), projects, button("登録", #selector(addProject)),
                       button("アーカイブ", #selector(archive)), NSView(), button("設定", #selector(settings))])
        let tabs = NSTabView()
        tab(tabs, "エージェント", [
            row([roles, button("再開", #selector(resume)), button("穏やかに停止", #selector(drain)),
                 button("即時停止", #selector(interrupt)), NSView(), label("許可する実験"), experiments]),
            activity, scroll(chat), row([input, button("開始 / 送信", #selector(send))]),
        ])
        tab(tabs, "研究", [
            row([button("課題を登録", #selector(addTask)), button("承認範囲で開始", #selector(startResearch)),
                 button("研究を再開", #selector(resumeResearch)), button("穏やかに停止", #selector(stopResearch)),
                 button("即時停止", #selector(interruptResearch)), NSView()]), scroll(research),
        ])
        tab(tabs, "実験", [
            row([jobs, button("テンプレートを登録", #selector(addExperiment)),
                 button("成果物を確認", #selector(loadArtifact)), NSView()]), scroll(logs),
        ])
        tab(tabs, "GitHub Issues", [
            row([button("一覧", #selector(loadIssues)), button("詳細", #selector(loadIssue)),
                 button("操作ポリシー", #selector(trackerPolicy)), button("下書き", #selector(trackerDraft)),
                 button("承認待ち", #selector(trackerReview)), NSView()]), scroll(issues),
        ])
        tab(tabs, "履歴と利用量", [row([button("購読枠を取得", #selector(loadLimits)), NSView()]), scroll(history)])
        let content = column([top, tabs, status])
        content.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        window.contentView = content
    }

    private func tab(_ tabs: NSTabView, _ title: String, _ views: [NSView]) {
        let item = NSTabViewItem(identifier: title)
        item.label = title
        let container = column(views)
        container.edgeInsets = NSEdgeInsets(top: 14, left: 12, bottom: 8, right: 12)
        item.view = container
        tabs.addTabViewItem(item)
    }

    private func row(_ views: [NSView]) -> NSStackView {
        let view = NSStackView(views: views)
        view.orientation = .horizontal
        view.alignment = .centerY
        view.spacing = 8
        return view
    }

    private func column(_ views: [NSView]) -> NSStackView {
        let view = NSStackView(views: views)
        view.orientation = .vertical
        view.alignment = .width
        view.spacing = 9
        return view
    }

    private func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }

    private func label(_ title: String) -> NSTextField {
        NSTextField(labelWithString: title)
    }

    private func scroll(_ view: NSTextView) -> NSScrollView {
        let container = NSScrollView()
        container.borderType = .bezelBorder
        container.hasVerticalScroller = true
        container.documentView = view
        view.isEditable = false
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainerInset = NSSize(width: 9, height: 7)
        view.font = NSFont.systemFont(ofSize: 13)
        return container
    }

    private func records(_ key: String) -> [Record] { snapshot[key] as? [Record] ?? [] }
    private var role: String { roles.titleOfSelectedItem ?? "coordinator" }

    private func request(_ action: String, _ args: Record = [:], done: ((Any) -> Void)? = nil) {
        bridge.call(action, args) { [weak self] result in
            if let error = result["error"] as? String {
                self?.status.stringValue = error
                if action == "status" { self?.refreshing = false }
                if action == "shutdown" { self?.closing = false }
            } else {
                done?(result["value"] ?? NSNull())
            }
        }
    }

    private func projectRequest(_ action: String, _ args: Record = [:], done: ((Any) -> Void)? = nil) {
        guard let id = selected else { return }
        request(action, args.merging(["project": id]) { _, new in new }, done: done)
    }

    private func refresh() {
        guard !closing && !refreshing else { return }
        refreshing = true
        let project = selected
        request("status", ["project": project as Any? ?? NSNull(), "after": cursor]) { [weak self] value in
            guard let self else { return }
            self.refreshing = false
            guard self.selected == project, let result = value as? Record else { return }
            self.apply(result)
        }
    }

    private func apply(_ result: Record) {
        snapshot = result
        let items = records("projects")
        refill(projects, items.map { "\($0["id"] ?? "") · \($0["name"] ?? "")" })
        if let index = items.firstIndex(where: { ($0["id"] as? Int) == selected }) {
            projects.selectItem(at: index)
        } else if let first = items.first?["id"] as? Int {
            changeProject(first)
        }
        refill(roles, records("roles").compactMap { $0["name"] as? String })
        refill(experiments, ["選択なし"] + records("templates").compactMap { $0["name"] as? String })
        refill(jobs, records("jobs").map { "\($0["name"] ?? "") · \($0["state"] ?? "") · \(($0["id"] as? String ?? "").prefix(8))" })
        events.append(contentsOf: records("events"))
        cursor = events.last?["id"] as? Int ?? cursor
        renderChat()
        renderResearch()
        if status.stringValue == "ADF に接続中" || status.stringValue == "ADF に接続済み" {
            status.stringValue = result["shutting_down"] as? Bool == true ? "停止処理中" : "ADF に接続済み"
        }
        if !showingArtifact && jobs.indexOfSelectedItem >= 0 && !logs.string.isEmpty { loadLog() }
    }

    private func refill(_ menu: NSPopUpButton, _ titles: [String]) {
        guard menu.itemTitles != titles else { return }
        let old = menu.titleOfSelectedItem
        menu.removeAllItems()
        menu.addItems(withTitles: titles)
        if let old, titles.contains(old) { menu.selectItem(withTitle: old) }
    }

    @objc private func renderChat() {
        let session = records("sessions").first { ($0["role"] as? String) == role } ?? [:]
        let option = records("roles").first { ($0["name"] as? String) == role } ?? [:]
        let model = option["model"] as? String ?? ""
        let effort = option["effort"] as? String ?? ""
        activity.stringValue = "\(session["state"] ?? "未開始")   |   \(model.isEmpty ? "既定モデル" : model)   |   \(effort.isEmpty ? "既定推論設定" : effort)"
        let sessionID = session["id"] as? Int
        var conversation = ""
        var activityLog = ""
        for event in events {
            let kind = event["kind"] as? String ?? ""
            let encoded = event["detail"] as? String ?? ""
            let value = try? JSONSerialization.jsonObject(with: Data(encoded.utf8), options: .fragmentsAllowed)
            let detail = value as? String ?? encoded
            if kind == "user" || kind == "assistant" {
                if let sessionID, event["session"] as? Int == sessionID {
                    conversation += kind == "user" ? "\n\nあなた\n\(detail)\n\n\(role)\n" : detail
                }
            } else {
                activityLog += "\(event["id"] ?? "") · \(kind) · \(detail)\n"
            }
        }
        if chat.string != conversation {
            chat.string = conversation
            chat.scrollToEndOfDocument(nil)
        }
        history.string = "\(role)    トークン \(session["tokens"] ?? 0) / 予算 \(option["budget"] ?? 0)\n"
            + "ターン要求 \(session["turn_requests"] ?? 0) 件\n" + usage + "\n" + activityLog
    }

    private func changeProject(_ value: Int?) {
        selected = value
        events.removeAll()
        cursor = 0
        showingArtifact = false
        logs.string = ""
        issues.string = ""
        experiments.selectItem(at: 0)
    }

    @objc private func selectProject() {
        let index = projects.indexOfSelectedItem
        let values = records("projects")
        if values.indices.contains(index) { changeProject(values[index]["id"] as? Int) }
    }

    @objc private func addProject() {
        let picker = NSOpenPanel()
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        guard picker.runModal() == .OK, let path = picker.url?.path,
              let fields = form("プロジェクト登録", [("表示名（任意）", ""), ("GitHub owner/repo（任意）", "")]) else { return }
        request("register", ["path": path, "name": fields[0], "github": fields[1]]) { [weak self] value in
            self?.changeProject((value as? Record)?["id"] as? Int)
        }
    }

    @objc private func archive() {
        let alert = NSAlert()
        alert.messageText = "プロジェクトを一覧から外しますか？"
        alert.addButton(withTitle: "アーカイブ")
        alert.addButton(withTitle: "キャンセル")
        if alert.runModal() == .alertFirstButtonReturn {
            projectRequest("archive") { [weak self] _ in self?.changeProject(nil) }
        }
    }

    @objc private func send() {
        let text = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var args: Record = ["role": role, "text": text]
        if experiments.indexOfSelectedItem > 0 { args["experiment"] = experiments.titleOfSelectedItem }
        projectRequest("send", args) { [weak self] _ in
            self?.input.stringValue = ""
            self?.experiments.selectItem(at: 0)
        }
    }

    @objc private func resume() { projectRequest("resume", ["role": role]) }
    @objc private func drain() { projectRequest("stop", ["role": role, "immediate": false]) }
    @objc private func interrupt() { projectRequest("stop", ["role": role, "immediate": true]) }

    private func renderResearch() {
        let run = records("research_runs").first ?? [:]
        let lines = records("research_tasks").map {
            "#\($0["id"] ?? "")  P\($0["priority"] ?? "")  \($0["state"] ?? "")  \($0["title"] ?? "")"
        }
        if run.isEmpty {
            research.string = lines.joined(separator: "\n")
        } else {
            research.string = "研究 \(run["state"] ?? "")  ·  現在の課題 #\(run["task"] ?? "")  ·  実験 \(run["jobs"] ?? 0) / \(run["job_limit"] ?? 0)\n\n"
                + lines.joined(separator: "\n")
        }
    }

    @objc private func addTask() {
        guard selected != nil, let fields = form("研究課題を登録", [
            ("課題名", ""), ("受け入れ条件", ""), ("優先度（1〜5）", "3"), ("依存課題 ID（カンマ区切り）", ""),
        ]), let priority = Int(fields[2]), let dependencies = identifiers(fields[3]) else { return }
        projectRequest("task", ["title": fields[0], "criteria": fields[1],
                                 "priority": priority, "dependencies": dependencies])
    }

    @objc private func startResearch() {
        guard selected != nil, let fields = form("自律研究を承認", [
            ("研究範囲と制約", ""), ("承認する課題 ID（カンマ区切り）", ""),
            ("実験回数の上限", "4"), ("実験単位の秒数上限", "120"),
            ("ターン上限", "8"), ("観測トークン予算", "40000"),
        ]), let ids = identifiers(fields[1]), !ids.isEmpty,
              let jobs = Int(fields[2]), let timeout = Int(fields[3]),
              let turns = Int(fields[4]), let tokens = Int(fields[5]) else { return }
        projectRequest("research-start", ["tasks": ids, "scope": fields[0], "jobs": jobs,
                                           "timeout": timeout, "turns": turns, "tokens": tokens])
    }

    private func identifiers(_ text: String) -> [Int]? {
        let parts = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        let numbers = parts.compactMap { Int($0) }
        return numbers.count == parts.count ? numbers : nil
    }

    @objc private func resumeResearch() { projectRequest("research-resume") }
    @objc private func stopResearch() { projectRequest("stop", ["role": "developer", "immediate": false]) }
    @objc private func interruptResearch() { projectRequest("stop", ["role": "developer", "immediate": true]) }

    @objc private func loadArtifact() {
        let index = jobs.indexOfSelectedItem
        let values = records("jobs")
        guard values.indices.contains(index), let job = values[index]["id"] as? String else { return }
        request("artifacts", ["job": job]) { [weak self] value in
            guard let self else { return }
            let files = (value as? [Record] ?? []).compactMap { $0["name"] as? String }
            guard let name = files.first else {
                self.status.stringValue = "この実験の成果物はありません"
                return
            }
            guard let fields = self.form("成果物  \(files.joined(separator: "、"))",
                                         [("ファイル名", name), ("開始バイト", "0")]),
                  let offset = Int(fields[1]) else { return }
            self.request("artifacts", ["job": job, "path": fields[0], "offset": offset, "size": 16384]) { result in
                if let page = result as? Record {
                    self.logs.string = "\(fields[0]) · \(page["offset"] ?? 0)–\(page["next"] ?? 0) / \(page["total"] ?? 0) バイト\n\n"
                        + (page["text"] as? String ?? "")
                    self.showingArtifact = true
                }
            }
        }
    }

    @objc private func addExperiment() {
        guard selected != nil, let fields = form("実験テンプレート",
              [("識別名", ""), ("コマンド引数（JSON 配列）", #"["/bin/sleep","35"]"#), ("制限時間（秒）", "60")]),
              let timeout = Int(fields[2]), let argv = (try? JSONSerialization.jsonObject(with: Data(fields[1].utf8))) as? [String]
        else { return }
        projectRequest("template", ["name": fields[0], "argv": argv, "timeout": timeout])
    }

    @objc private func loadLog() {
        showingArtifact = false
        let index = jobs.indexOfSelectedItem
        let values = records("jobs")
        guard values.indices.contains(index), let job = values[index]["id"] as? String else { return }
        request("log", ["job": job]) { [weak self] value in
            guard let self, self.jobs.indexOfSelectedItem == index else { return }
            let state = values[index]["state"] as? String ?? ""
            self.logs.string = "\(job) · \(state) · 終了コード \(values[index]["exit_code"] ?? "未確定")\n\n"
                + (value as? String ?? "")
        }
    }

    @objc private func loadIssues() {
        projectRequest("issues") { [weak self] value in
            self?.issues.string = (value as? [Record] ?? []).map {
                "#\($0["number"] ?? "") \($0["state"] ?? "") \($0["title"] ?? "")\n\($0["url"] ?? "")"
            }.joined(separator: "\n\n")
        }
    }

    @objc private func loadIssue() {
        guard let fields = form("GitHub Issue", [("Issue 番号", "")]), let issue = Int(fields[0]) else { return }
        projectRequest("tracker-issue", ["issue": issue]) { [weak self] value in
            self?.issues.string = self?.jsonText(value) ?? ""
        }
    }

    @objc private func trackerPolicy() {
        guard let fields = form("ローカルのトラッカーポリシー", [
            ("許可する操作（proposal, comment, progress, depends, label, checklist, complete）", ""),
        ]) else { return }
        let operations = fields[0].split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        projectRequest("tracker-policy", ["operations": operations])
    }

    @objc private func trackerDraft() {
        guard let fields = form("GitHub 操作の下書き", [
            ("操作の種類", "proposal"), ("操作内容（JSON）", #"{"title":"","body":"","priority":"P2"}"#),
        ]), let payload = (try? JSONSerialization.jsonObject(with: Data(fields[1].utf8))) as? Record
        else { return }
        projectRequest("tracker-draft", ["kind": fields[0], "payload": payload]) { [weak self] value in
            self?.status.stringValue = "承認待ち: \(value)"
        }
    }

    @objc private func trackerReview() {
        let drafts = records("tracker_operations").filter { ($0["state"] as? String) == "pending" }
        guard let first = drafts.first else {
            status.stringValue = "承認待ちの操作はありません"
            return
        }
        let summary = drafts.map { "\(($0["id"] as? String ?? "").prefix(12)) · \($0["kind"] ?? "")" }
        guard let fields = form("承認待ち  \(summary.prefix(8).joined(separator: "、"))",
              [("操作 ID または先頭12文字", String((first["id"] as? String ?? "").prefix(12)))]),
              let draft = drafts.first(where: { ($0["id"] as? String)?.hasPrefix(fields[0]) == true }),
              fields[0].count >= 12, let id = draft["id"] as? String else { return }
        let alert = NSAlert()
        alert.messageText = "\(draft["repository"] ?? "") · \(draft["kind"] ?? "")"
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 510, height: 210))
        text.string = draft["payload"] as? String ?? ""
        let accessory = scroll(text)
        accessory.frame = NSRect(x: 0, y: 0, width: 510, height: 210)
        alert.accessoryView = accessory
        alert.addButton(withTitle: "保留")
        alert.addButton(withTitle: "GitHub に送信")
        alert.addButton(withTitle: "却下")
        switch alert.runModal() {
        case .alertSecondButtonReturn: request("tracker-review", ["operation": id, "approve": true])
        case .alertThirdButtonReturn: request("tracker-review", ["operation": id, "approve": false])
        default: break
        }
    }

    private func jsonText(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
        else { return "" }
        return String(decoding: data, as: UTF8.self)
    }

    @objc private func loadLimits() {
        request("limits") { [weak self] value in
            guard let self, let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
            else { return }
            self.usage = "公式購読枠\n" + String(decoding: data, as: UTF8.self)
            self.renderChat()
        }
    }

    @objc private func settings() {
        let value = records("roles").first { ($0["name"] as? String) == role } ?? [:]
        guard let fields = form("ロール設定", [
            ("ロール名（新しい名前で追加）", role), ("追加指示", value["instructions"] as? String ?? ""),
            ("モデル", value["model"] as? String ?? ""), ("推論設定", value["effort"] as? String ?? ""),
            ("利用枠回復（manual / confirmed）", value["recovery"] as? String ?? "manual"),
            ("トークン予算（0 は上限なし）", String(value["budget"] as? Int ?? 0)),
        ]), let budget = Int(fields[5]) else { return }
        request("role", ["name": fields[0], "instructions": fields[1], "model": fields[2],
                         "effort": fields[3], "recovery": fields[4], "budget": budget])
    }

    private func form(_ title: String, _ specifications: [(String, String)]) -> [String]? {
        var fields = [NSTextField]()
        var views = [NSView]()
        for (name, initial) in specifications {
            let field = NSTextField(string: initial)
            fields.append(field)
            views += [label(name), field]
        }
        let content = column(views)
        content.frame = NSRect(x: 0, y: 0, width: 425, height: CGFloat(specifications.count) * 66)
        let alert = NSAlert()
        alert.messageText = title
        alert.accessoryView = content
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "キャンセル")
        return alert.runModal() == .alertFirstButtonReturn ? fields.map(\.stringValue) : nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        closeRequested()
        return false
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if closing || CommandLine.arguments.contains("--smoke") { return .terminateNow }
        closeRequested()
        return .terminateCancel
    }

    private func closeRequested() {
        guard !closing else { return }
        let alert = NSAlert()
        alert.messageText = "実行中の作業をどうしますか？"
        alert.addButton(withTitle: "安全に停止")
        alert.addButton(withTitle: "バックグラウンドで継続")
        alert.addButton(withTitle: "キャンセル")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            closing = true
            request("shutdown") { _ in NSApp.terminate(nil) }
        case .alertSecondButtonReturn:
            closing = true
            DispatchQueue.main.async { NSApp.terminate(nil) }
        default: break
        }
    }
}

@main
struct Application {
    @MainActor
    static func main() {
        let app = NSApplication.shared
        let desktop = Desktop()
        app.setActivationPolicy(.regular)
        app.delegate = desktop
        app.run()
    }
}
