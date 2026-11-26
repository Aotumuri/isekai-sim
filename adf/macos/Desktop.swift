import AppKit

typealias Record = [String: Any]

@MainActor
final class Desktop: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTabViewDelegate {
    private let bridge = Bridge()
    private let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1050, height: 720),
        styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    private let projects = NSPopUpButton()
    private let roles = NSPopUpButton()
    private let experiments = NSPopUpButton()
    private let jobs = NSPopUpButton()
    let status = NSTextField(labelWithString: "ADF に接続中")
    private let heading = NSTextField(labelWithString: "")
    private let overview = NSTextField(wrappingLabelWithString: "")
    private let quota = NSTextField(wrappingLabelWithString: "公式利用枠 · 未取得")
    private var connected = false
    private var projectButtons = [NSButton]()
    private var projectLoaded = false
    private let activity = NSTextField(labelWithString: "")
    private let chat = NSTextView()
    private let logs = NSTextView()
    private let issues = NSTextView()
    private let history = NSTextView()
    private let research = NSTextView()
    private let input = NSTextField()
    private weak var tabView: NSTabView?
    private var fetchingLog = false
    private(set) var snapshot: Record = [:]
    private var events = [Record]()
    private var usage = ""
    private(set) var selected: Int?
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
            selected = 1
            apply(["projects": [["id": 1, "name": "動作確認"]], "roles": [["name": "coordinator"]],
                   "sessions": [["role": "developer", "state": "waiting", "tokens": 17, "turn_requests": 1]],
                   "research_preset": ["name": "autonomous", "jobs": 0, "turns": 0, "tokens": 0, "recovery": "confirmed"],
                   "research_runs": [["state": "queued", "job_limit": 0, "turn_limit": 0, "token_limit": 0]],
                   "jobs": [], "templates": [], "events": [], "shutting_down": false])
            window.displayIfNeeded()
            precondition(window.isVisible && projects.numberOfItems == 1 && roles.numberOfItems == 1)
            precondition(research.string.contains("Autonomous") && research.string.contains("課題待機")
                         && research.string.contains("17 / 無制限"))
            print("AppKit desktop constructed and rendered")
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { NSApp.terminate(nil) }
            return
        }
        selected = UserDefaults.standard.object(forKey: "lastProject") as? Int
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
        let top = row([label("プロジェクト"), projects, button("プロジェクトを登録", #selector(addProject)),
                       button("アーカイブ", #selector(archive)), NSView(), button("ロール設定", #selector(settings))])
        let tabs = NSTabView()
        tabs.delegate = self
        tabView = tabs
        tab(tabs, "エージェント", [
            row([roles, button("再開", #selector(resume)), button("穏やかに停止", #selector(drain)),
                 button("即時停止", #selector(interrupt)), NSView(), label("許可する実験"), experiments]),
            activity, scroll(chat), row([input, button("開始 / 送信", #selector(send))]),
        ])
        tab(tabs, "研究", [
            row([button("課題を登録", #selector(addTask)), button("承認範囲で開始", #selector(startResearch)),
                 button("研究を再開", #selector(resumeResearch)), button("穏やかに停止", #selector(stopResearch)),
                 button("即時停止", #selector(interruptResearch)), button("差分確認", #selector(commitPreview)), NSView()]),
            row([button("運用プリセット", #selector(changeResearchPreset)), NSView()]), scroll(research),
        ])
        tab(tabs, "実験", [
            row([jobs, button("テンプレートを登録", #selector(addExperiment)),
                 button("ログを表示", #selector(loadLog)), button("成果物", #selector(loadArtifact)), button("入力記録", #selector(loadInputs)), NSView()]), scroll(logs),
        ])
        tab(tabs, "GitHub Issues", [
            row([button("一覧", #selector(loadIssues)), button("詳細", #selector(loadIssue)),
                 button("操作ポリシー", #selector(trackerPolicy)), button("下書き", #selector(trackerDraft)),
                 button("承認待ち", #selector(trackerReview)), button("結果照合", #selector(trackerReconcile)), NSView()]), scroll(issues),
        ])
        tab(tabs, "履歴と利用量", [row([button("購読枠を取得", #selector(loadLimits)), button("トークン内訳", #selector(loadUsage)), NSView()]), scroll(history)])
        for menu in [projects, roles, experiments, jobs] {
            menu.cell?.lineBreakMode = .byTruncatingTail
            menu.widthAnchor.constraint(lessThanOrEqualToConstant: 240).isActive = true
        }
        heading.lineBreakMode = .byTruncatingTail
        heading.font = .systemFont(ofSize: 19, weight: .semibold)
        overview.font = .systemFont(ofSize: 13)
        quota.textColor = .secondaryLabelColor
        status.textColor = .secondaryLabelColor
        let quotaRow = row([quota, NSView(), button("利用枠を取得", #selector(loadLimits))])
        let content = column([top, heading, overview, quotaRow, tabs, status])
        content.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        window.contentView = content
        for view in [top, heading, overview, quotaRow, tabs, status] {
            view.widthAnchor.constraint(equalTo: content.widthAnchor, constant: -32).isActive = true
        }
        renderOverview()
    }

    func tabView(_ tabView: NSTabView, didSelect tabViewItem: NSTabViewItem?) {
        if tabViewItem?.identifier as? String == "実験", !showingArtifact { loadLog() }
    }

    private func tab(_ tabs: NSTabView, _ title: String, _ views: [NSView]) {
        let item = NSTabViewItem(identifier: title)
        item.label = title
        let container = NSView()
        var previous: NSView?
        for view in views {
            view.translatesAutoresizingMaskIntoConstraints = false
            container.addSubview(view)
            let top = previous.map { view.topAnchor.constraint(equalTo: $0.bottomAnchor, constant: 9) }
                ?? view.topAnchor.constraint(equalTo: container.topAnchor, constant: 14)
            NSLayoutConstraint.activate([
                top, view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 12),
                view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -12),
            ])
            if view is NSScrollView {
                view.heightAnchor.constraint(greaterThanOrEqualToConstant: 80).isActive = true
            }
            previous = view
        }
        previous?.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -8).isActive = true
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
        let button = NSButton(title: title, target: self, action: action)
        if ![#selector(addProject), #selector(settings), #selector(loadLimits)].contains(action) {
            projectButtons.append(button)
        }
        return button
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
        view.drawsBackground = true
        view.backgroundColor = .textBackgroundColor
        view.textColor = .textColor
        view.isVerticallyResizable = true
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainerInset = NSSize(width: 9, height: 7)
        view.font = NSFont.systemFont(ofSize: 13)
        return container
    }

    func records(_ key: String) -> [Record] { snapshot[key] as? [Record] ?? [] }
    var role: String { roles.titleOfSelectedItem ?? "coordinator" }

    func request(_ action: String, _ args: Record = [:], success: String? = nil,
                 done: ((Any) -> Void)? = nil, failed: (() -> Void)? = nil) {
        bridge.call(action, args) { [weak self] result in
            guard let self else { return }
            if let error = result["error"] as? String {
                if action == "status" {
                    self.refreshing = false
                    self.connected = false
                    self.renderOverview()
                }
                if action == "shutdown" { self.closing = false }
                self.status.stringValue = "操作を確認してください · \(error)"
                self.status.toolTip = self.status.stringValue
                failed?()
                return
            }
            if let success {
                self.status.stringValue = success
                self.status.toolTip = nil
            }
            done?(result["value"] ?? NSNull())
            if success != nil { self.refresh() }
        }
    }

    func projectRequest(_ action: String, _ args: Record = [:], success: String? = nil,
                                done: ((Any) -> Void)? = nil) {
        guard let id = selected, connected else { return }
        request(action, args.merging(["project": id]) { _, new in new }, success: success) { [weak self] value in
            guard self?.selected == id else { return }
            done?(value)
        }
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
        let reconnecting = !connected
        connected = true
        if reconnecting { status.stringValue = "ADF に接続済み" }
        snapshot = result
        let items = records("projects")
        refill(projects, items.map { "\($0["id"] ?? "") · \($0["name"] ?? "")" })
        if let index = items.firstIndex(where: { ($0["id"] as? Int) == selected }) {
            projectLoaded = true
            projects.selectItem(at: index)
        } else if let first = items.first?["id"] as? Int {
            changeProject(first)
        } else if selected != nil {
            changeProject(nil)
        }
        refill(roles, records("roles").compactMap { $0["name"] as? String })
        refill(experiments, ["選択なし"] + records("templates").compactMap { $0["name"] as? String })
        let currentJob = jobs.selectedItem?.representedObject as? String
        let jobRecords = records("jobs")
        refill(jobs, jobRecords.map { "\($0["name"] ?? "") · \(Overview.jobState($0["state"])) · \(($0["id"] as? String ?? "").prefix(8))" })
        for (index, job) in jobRecords.enumerated() {
            jobs.item(at: index)?.representedObject = job["id"]
        }
        if let currentJob, let index = jobRecords.firstIndex(where: { $0["id"] as? String == currentJob }) {
            jobs.selectItem(at: index)
        }
        events.append(contentsOf: records("events"))
        cursor = events.last?["id"] as? Int ?? cursor
        renderChat()
        renderResearch()
        renderOverview()
        if tabView?.selectedTabViewItem?.identifier as? String == "実験", !showingArtifact,
           jobs.indexOfSelectedItem >= 0, !fetchingLog { loadLog() }
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
        activity.stringValue = "ロール設定 · \(model.isEmpty ? "既定モデル" : model) · \(effort.isEmpty ? "既定の推論強度" : effort)"
        renderOverview()
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
        let summary = records("sessions").map {
            "\($0["role"] ?? "") · 観測トークン \($0["tokens"] ?? 0) · ターン要求 \($0["turn_requests"] ?? 0) 件"
        }.joined(separator: "\n")
        let historyText = summary + "\n\n" + usage + "\n\n" + activityLog
        if history.string != historyText { history.string = historyText }
    }

    private func changeProject(_ value: Int?) {
        selected = value
        projectLoaded = false
        UserDefaults.standard.set(value, forKey: "lastProject")
        events.removeAll()
        cursor = 0
        showingArtifact = false
        for key in ["sessions", "research_runs", "research_tasks", "github_runs", "tracker_operations",
                    "jobs", "templates", "tracker_policy", "research_preset", "events"] {
            snapshot.removeValue(forKey: key)
        }
        renderOverview()
        renderChat()
        renderResearch()
        logs.string = ""
        issues.string = ""
        jobs.removeAllItems()
        experiments.selectItem(at: 0)
    }

    @objc private func selectProject() {
        let index = projects.indexOfSelectedItem
        let values = records("projects")
        if values.indices.contains(index) {
            changeProject(values[index]["id"] as? Int)
            refresh()
        }
    }

    @objc private func addProject() {
        let picker = NSOpenPanel()
        picker.message = "研究対象の Git 作業フォルダを選んでください。"
        picker.canChooseFiles = false
        picker.canChooseDirectories = true
        guard picker.runModal() == .OK, let path = picker.url?.path,
              let fields = form("プロジェクト登録", [("表示名（任意）", ""), ("GitHub owner/repo（任意）", "")],
                                detail: path, confirm: "登録") else { return }
        request("register", ["path": path, "name": fields[0], "github": fields[1]],
                success: "プロジェクトを登録しました") { [weak self] value in
            self?.changeProject((value as? Record)?["id"] as? Int)
        }
    }

    @objc private func archive() {
        let alert = NSAlert()
        alert.messageText = "プロジェクトを一覧から外しますか？"
        alert.addButton(withTitle: "アーカイブ")
        alert.addButton(withTitle: "キャンセル")
        if alert.runModal() == .alertFirstButtonReturn {
            projectRequest("archive", success: "プロジェクトをアーカイブしました") { [weak self] _ in self?.changeProject(nil) }
        }
    }

    @objc private func send() {
        let text = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var args: Record = ["role": role, "text": text]
        if role == "developer", experiments.indexOfSelectedItem > 0 { args["experiment"] = experiments.titleOfSelectedItem }
        let project = selected
        let template = experiments.titleOfSelectedItem
        projectRequest("send", args, success: "メッセージを受け付けました") { [weak self] _ in
            guard let self, self.selected == project, self.role == args["role"] as? String else { return }
            if self.input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) == text {
                self.input.stringValue = ""
            }
            if self.experiments.titleOfSelectedItem == template { self.experiments.selectItem(at: 0) }
        }
    }

    @objc private func resume() { projectRequest("resume", ["role": role], success: "再開を受け付けました") }
    @objc private func drain() { projectRequest("stop", ["role": role, "immediate": false], success: "停止を受け付けました") }
    @objc private func interrupt() { confirmInterrupt(role) }

    func confirmInterrupt(_ role: String) {
        let alert = NSAlert()
        alert.messageText = "\(role) を即時停止しますか？"
        alert.informativeText = "進行中のターンと実験を中断します。"
        alert.addButton(withTitle: "キャンセル")
        alert.addButton(withTitle: "即時停止").hasDestructiveAction = true
        if alert.runModal() == .alertSecondButtonReturn {
            projectRequest("stop", ["role": role, "immediate": true], success: "即時停止を受け付けました")
        }
    }

    private func limitText(_ limit: Int?) -> String {
        guard let limit else { return "要指定" }
        return limit == 0 ? "無制限" : limit.formatted()
    }

    private func renderOverview() {
        let active = connected && projectLoaded
        projects.isEnabled = connected && projects.numberOfItems > 1
        projectButtons.forEach { $0.isEnabled = active && canAct($0.action) }
        input.isEnabled = active
        experiments.isEnabled = active && role == "developer"
        jobs.isEnabled = active && !records("jobs").isEmpty
        guard active else {
            heading.stringValue = connected && selected == nil ? "プロジェクトを登録して開始" : "ADF に接続中"
            overview.stringValue = connected && selected == nil
                ? "Git の作業フォルダを登録すると、Coordinator と対話し、Developer に研究を任せられます。"
                : "監督との接続とプロジェクトの状態を確認しています。"
            return
        }
        let developer = session("developer")
        let run = records("research_runs").first ?? [:]
        let remote = records("github_runs").first ?? [:]
        let approval = records("tracker_operations").filter { $0["state"] as? String == "pending" }
        let waiting = approval.contains { ($0["id"] as? String) == (remote["operation"] as? String) }
        let job = records("jobs").first { $0["state"] as? String == "running" && $0["session"] as? Int == developer["id"] as? Int }
        let state = Overview.state(developer, run: run, job: job, approval: waiting)
        let task = records("research_tasks").first { $0["id"] as? Int == run["task"] as? Int }
        let topic = task?["title"] as? String ?? (remote["issue"] as? Int).map { "GitHub #\($0)" }
        let coordinator = session("coordinator")
        let coordinatorState = Overview.state(coordinator)
        let preset = Overview.decode(run["scope"])["preset"] as? Record
        let roleOption = records("roles").first { $0["name"] as? String == "developer" }
        let recovery = preset?["recovery"] as? String ?? roleOption?["recovery"] as? String ?? "manual"
        let next = Overview.next(state, recovery: recovery, hasResearch: !run.isEmpty)
        heading.stringValue = topic ?? (run.isEmpty ? "研究の準備" : state)
        var lines = ["Coordinator · \(coordinatorState)     Developer · \(state)"]
        if let jobName = job?["name"] as? String { lines.append("実験 · \(jobName)") }
        if !run.isEmpty {
            let used = max(0, (developer["tokens"] as? Int ?? 0) - (run["start_tokens"] as? Int ?? 0))
            lines.append("研究予算 · 観測トークン \(used.formatted()) / \(limitText(run["token_limit"] as? Int))")
        }
        if !approval.isEmpty { lines.append("確認が必要な GitHub 操作 · \(approval.count) 件") }
        if ["停止中", "中断・確認が必要", "研究課題が保留", "公式利用枠の回復待ち"].contains(state),
           let reason = stopReason(developer) { lines.append("理由 · \(reason)") }
        if !next.isEmpty { lines.append("Developer · " + next) }
        if coordinatorState == "公式利用枠の回復待ち" || coordinatorState == "中断・確認が必要" {
            let option = records("roles").first { $0["name"] as? String == "coordinator" }
            let action = Overview.next(coordinatorState, recovery: option?["recovery"] as? String ?? "manual", hasResearch: false)
            lines.append("Coordinator · " + action)
        }
        overview.stringValue = lines.joined(separator: "\n")
        overview.toolTip = overview.stringValue
        if snapshot["shutting_down"] as? Bool == true { heading.stringValue = "監督は停止処理中です" }
    }

    private func canAct(_ action: Selector?) -> Bool {
        let run = records("research_runs").first
        let runState = run?["state"] as? String
        let roleState = session(role)["state"] as? String
        let developerState = session("developer")["state"] as? String
        let stopping = ["running", "waiting", "idle", "quota", "draining"]
        let resumable = ["paused", "interrupted", "quota"]
        switch action {
        case #selector(resume): return resumable.contains(roleState ?? "")
        case #selector(drain), #selector(interrupt): return stopping.contains(roleState ?? "")
        case #selector(stopResearch), #selector(interruptResearch):
            return run != nil && stopping.contains(developerState ?? "")
        case #selector(resumeResearch):
            return run != nil && runState != "completed" && runState != "blocked"
                && resumable.contains(developerState ?? "")
                && !records("tracker_operations").contains { operation in
                    operation["state"] as? String == "pending"
                        && operation["id"] as? String == records("github_runs").first?["operation"] as? String
                }
        case #selector(addTask): return !isGitHubProject
        case #selector(loadIssues), #selector(loadIssue), #selector(trackerPolicy), #selector(trackerDraft),
             #selector(trackerReview), #selector(trackerReconcile): return isGitHubProject
        case #selector(startResearch):
            return !["running", "waiting", "draining", "stopping", "idle"].contains(developerState ?? "")
                && (isGitHubProject || !localTasks(readyOnly: true).isEmpty)
        case #selector(loadLog), #selector(loadArtifact), #selector(loadInputs):
            return !records("jobs").isEmpty
        default: return true
        }
    }

    private func session(_ role: String) -> Record {
        records("sessions").first { $0["role"] as? String == role } ?? [:]
    }

    private func stopReason(_ session: Record) -> String? {
        guard let id = session["id"] as? Int else { return nil }
        for event in events.reversed() where event["session"] as? Int == id {
            switch event["kind"] as? String {
            case "start", "resume", "research_task": return nil
            case "quota", "error", "stop", "recovered", "research_blocked", "github_pause":
                guard let raw = event["detail"] as? String else { continue }
                return (try? JSONSerialization.jsonObject(with: Data(raw.utf8), options: .fragmentsAllowed)) as? String
            case "turn":
                let info = Overview.decode(event["detail"])
                if info["usage_limit"] as? Bool == true { return "Codex の公式利用枠に達しました。" }
                if info["status"] as? String == "failed" { return "Codex のターンが失敗しました。履歴を確認してください。" }
            default: continue
            }
        }
        return nil
    }

    private func renderResearch() {
        let run = records("research_runs").first ?? [:]
        let remote = records("github_runs").first ?? [:]
        let lines = records("research_tasks").map {
            "#\($0["id"] ?? "")  P\($0["priority"] ?? "")  \(Overview.taskState($0["state"]))  \($0["title"] ?? "")"
        }
        let preset = snapshot["research_preset"] as? Record ?? [:]
        let settings = "次回の設定: \((preset["name"] as? String)?.capitalized ?? "未設定")  ·  観測トークン \(limitText(preset["tokens"] as? Int))  ·  ターン \(limitText(preset["turns"] as? Int))  ·  実験 \(limitText(preset["jobs"] as? Int))  ·  公式利用枠回復 \(Overview.recovery(preset["recovery"]))\n"
        let presentation: String
        if run.isEmpty {
            let firstStep = isGitHubProject ? "GitHub Issues から研究対象を選べます。"
                : "「課題を登録」で、課題名と完了を判断する条件を設定してください。"
            presentation = settings + "\n" + (lines.isEmpty ? firstStep : lines.joined(separator: "\n"))
        } else {
            let developer = records("sessions").first { ($0["role"] as? String) == "developer" } ?? [:]
            let used = max(0, (developer["tokens"] as? Int ?? 0) - (run["start_tokens"] as? Int ?? 0))
            let limit = run["token_limit"] as? Int ?? 0
            let config = (run["scope"] as? String).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? Record }
            let activePreset = config?["preset"] as? Record
            let turns = max(0, (developer["turn_requests"] as? Int ?? 0) - (run["start_turns"] as? Int ?? 0))
            let reason = limit > 0 && used >= limit ? " · 予算到達（研究を再開して合計予算を指定）" : ""
            let state = Overview.state(developer, run: run,
                                       job: records("jobs").first { $0["state"] as? String == "running" })
            let recovery = Overview.recovery(activePreset?["recovery"])
            let task = (remote["issue"] as? Int ?? run["task"] as? Int).map { "#\($0)" } ?? "未選択"
            let effectiveName = (activePreset?["name"] as? String)?.capitalized ?? "個別設定"
            let review = activePreset?["github_review"] as? String == "ask" || preset["github_review"] as? String == "ask"
                ? "個別承認" : "プロジェクトポリシー"
            presentation = settings + "\n研究 \(state)  ·  \(effectiveName)  ·  課題 \(task)  ·  実験 \(run["jobs"] ?? 0) / \(limitText(run["job_limit"] as? Int))  ·  ターン \(turns) / \(limitText(run["turn_limit"] as? Int))\n"
                + "観測トークン \(used.formatted()) / \(limitText(limit))（キャッシュ済み入力を含む）\(reason)\n"
                + "実験 1 回 \(run["timeout"] ?? "-") 秒  ·  公式利用枠回復 \(recovery)  ·  GitHub 書き込み \(review)\n\n"
                + lines.joined(separator: "\n")
        }
        if research.string != presentation { research.string = presentation }
    }

    @objc private func commitPreview() {
        projectRequest("commit-preview") { [weak self] value in
            guard let self, let report = value as? Record else { return }
            let files = report["files"] as? [Record] ?? []
            let ignored = (report["excluded_prior_changes"] as? [String] ?? []).joined(separator: ", ")
            self.showDocument("Git 差分の確認", "HEAD \(report["base"] ?? "")\n開始前の変更（除外）: \(ignored)\n\n"
                + files.map { "\($0["path"] ?? "")\n\($0["patch"] ?? "")" }.joined(separator: "\n"))
        }
    }

    @objc private func loadInputs() {
        let index = jobs.indexOfSelectedItem
        let values = records("jobs")
        guard values.indices.contains(index), let job = values[index]["id"] as? String else { return }
        request("experiment-inputs", ["job": job]) { [weak self] value in
            guard let self else { return }
            self.showDocument("実験入力記録", self.jsonText(value))
        }
    }

    @objc private func loadUsage() {
        projectRequest("usage") { [weak self] value in
            guard let self else { return }
            self.showDocument("トークン内訳と購読枠", self.jsonText(value))
        }
    }

    private func showDocument(_ title: String, _ content: String) {
        let alert = NSAlert()
        alert.messageText = title
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 580, height: 300))
        text.string = content
        let document = scroll(text)
        document.frame = NSRect(x: 0, y: 0, width: 580, height: 300)
        alert.accessoryView = document
        alert.addButton(withTitle: "閉じる")
        alert.runModal()
    }

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
            let form = Form("成果物を表示")
            let file = form.choice("ファイル", files, initial: files.firstIndex(of: name) ?? 0)
            let position = form.field("開始バイト", "0")
            guard form.confirm("表示") else { return }
            guard let offset = Int(position.stringValue), offset >= 0,
                  let path = file.titleOfSelectedItem else {
                self.status.stringValue = "開始バイトに 0 以上の整数を入力してください。"
                return
            }
            self.request("artifacts", ["job": job, "path": path, "offset": offset, "size": 16384]) { result in
                if let page = result as? Record, self.jobs.selectedItem?.representedObject as? String == job {
                    self.logs.string = "\(path) · \(page["offset"] ?? 0)–\(page["next"] ?? 0) / \(page["total"] ?? 0) バイト\n\n"
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
        fetchingLog = true
        request("log", ["job": job]) { [weak self] value in
            guard let self else { return }
            self.fetchingLog = false
            guard !self.showingArtifact, self.jobs.selectedItem?.representedObject as? String == job else { return }
            let state = Overview.jobState(values[index]["state"])
            let output = "\(job) · \(state) · 終了コード \((values[index]["exit_code"] as? Int).map { String($0) } ?? "未確定")\n\n"
                + (value as? String ?? "")
            if self.logs.string != output { self.logs.string = output }
        } failed: { [weak self] in
            self?.fetchingLog = false
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
        let current = snapshot["tracker_policy"] as? [String: String] ?? [:]
        let operations = [("proposal", "Issue 作成"), ("comment", "コメント"), ("progress", "進捗"),
                          ("depends", "依存関係"), ("label", "ラベル"), ("checklist", "チェックリスト"),
                          ("complete", "完了・クローズ")]
        let levels = ["deny", "ask", "allow"]
        let form = Form("GitHub の操作ポリシー",
                        detail: "ここで設定した許可範囲は、プロジェクト側の制約と照合されます。")
        let choices = operations.map { key, title in
            form.choice(title, ["禁止", "個別承認", "自動送信を許可"],
                        initial: levels.firstIndex(of: current[key] ?? "deny") ?? 0)
        }
        guard form.confirm("ポリシーを保存") else { return }
        let values = zip(operations, choices).map { operation, choice in
            (operation.0, levels[choice.indexOfSelectedItem])
        }
        projectRequest("tracker-policy", ["operations": Dictionary(uniqueKeysWithValues: values)],
                       success: "GitHub の操作ポリシーを保存しました")
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

    @objc private func trackerReconcile() {
        let uncertain = records("tracker_operations").first { row in
            (row["state"] as? String) == "sending" && ["progress", "complete", "checklist"].contains(row["kind"] as? String ?? "")
        }
        guard let fields = form("結果不明の GitHub 操作を読み取りで照合",
                                [("操作 ID", uncertain?["id"] as? String ?? "")]), !fields[0].isEmpty else { return }
        request("tracker-reconcile", ["operation": fields[0]]) { [weak self] _ in
            self?.status.stringValue = "GitHub の現在の状態と照合しました"
        }
    }

    @objc private func trackerReview() {
        let drafts = records("tracker_operations").filter { ($0["state"] as? String) == "pending" }
        guard !drafts.isEmpty else {
            status.stringValue = "承認待ちの操作はありません"
            return
        }
        let summary = drafts.map { draft in
            let issue = Overview.decode(draft["payload"])["issue"] as? Int
            let target = issue.map { "Issue #\($0)" } ?? "新規提案"
            return "\(target) · \(draft["kind"] ?? "") · \((draft["id"] as? String ?? "").prefix(12))"
        }
        let form = Form("GitHub の承認待ち")
        let choice = form.choice("確認する操作", summary)
        guard form.confirm("送信内容を確認") else { return }
        let draft = drafts[choice.indexOfSelectedItem]
        guard let id = draft["id"] as? String else { return }
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
        quota.stringValue = "公式利用枠 · 取得中"
        request("limits") { [weak self] value in
            guard let self, let response = value as? Record else { return }
            self.usage = Overview.quota(response) + "\n取得 " + Date().formatted(date: .omitted, time: .shortened)
            self.quota.stringValue = "公式利用枠 · " + self.usage
            self.renderChat()
        } failed: { [weak self] in
            self?.quota.stringValue = "公式利用枠 · 取得失敗"
        }
    }

    func form(_ title: String, _ specifications: [(String, String)], detail: String = "",
                      confirm: String = "続ける") -> [String]? {
        let form = Form(title, detail: detail)
        let fields = specifications.map { form.field($0.0, $0.1) }
        return form.confirm(confirm) ? fields.map(\.stringValue) : nil
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
