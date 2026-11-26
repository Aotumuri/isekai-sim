import AppKit

@MainActor
extension Desktop {
    var isGitHubProject: Bool {
        let project = records("projects").first { $0["id"] as? Int == selected }
        return (project?["github"] as? String ?? "") != ""
    }

    func localTasks(readyOnly: Bool) -> [(id: Int, title: String)] {
        records("research_tasks").compactMap { task in
            guard !readyOnly || task["state"] as? String == "ready",
                  let id = task["id"] as? Int, let title = task["title"] as? String else { return nil }
            return (id, "#\(id) · \(title)")
        }
    }

    @objc func addTask() {
        guard selected != nil else { return }
        let form = Form("研究課題を登録", detail: "Developer が完了を判断できる観測結果や成果物を指定してください。")
        let title = form.field("課題名")
        let criteria = form.paragraph("受け入れ条件")
        let priority = form.choice("優先度", ["P1 · 最高", "P2", "P3", "P4", "P5 · 最低"], initial: 2)
        let dependencies = form.checklist("先に完了が必要な課題（任意）", localTasks(readyOnly: false))
        guard form.confirm("課題を登録") else { return }
        projectRequest("task", ["title": title.stringValue, "criteria": criteria.string,
                                 "priority": priority.indexOfSelectedItem + 1, "dependencies": dependencies()],
                       success: "研究課題を登録しました")
    }

    @objc func changeResearchPreset() {
        let current = snapshot["research_preset"] as? Record ?? [:]
        let names = ["manual", "controlled", "autonomous"]
        let form = Form("運用プリセット", detail: "Manual は手動復帰と GitHub 個別承認。Controlled は上限と既存の権限を使用。Autonomous は上限なしを初期値とし、公式利用枠の回復確認後に再開します。")
        let choice = form.choice("次回の研究に使う設定", ["Manual", "Controlled", "Autonomous"],
                                 initial: names.firstIndex(of: current["name"] as? String ?? "") ?? 1)
        guard let project = selected, form.confirm("上限を確認") else { return }
        let name = names[choice.indexOfSelectedItem]
        projectRequest("research-preset", ["name": name]) { [weak self] value in
            guard let self, self.selected == project, let defaults = value as? Record else { return }
            self.editPreset(name, values: current["name"] as? String == name ? current : defaults)
        }
    }

    private func editPreset(_ name: String, values: Record) {
        let form = Form("\(name.capitalized) の上限", detail: "保存値は次回の研究開始時に読み込まれます。")
        let fields = researchLimits(form, values)
        let recovery = recoveryChoice(form, values, manualOnly: name == "manual")
        guard form.confirm("プリセットを保存"), var args = readLimits(fields) else { return }
        args["name"] = name
        args["apply"] = true
        args["recovery"] = recovery.indexOfSelectedItem == 1 ? "confirmed" : "manual"
        projectRequest("research-preset", args, success: "\(name.capitalized) を次回の設定として保存しました")
    }

    func recoveryChoice(_ form: Form, _ values: Record, manualOnly: Bool = false) -> NSPopUpButton {
        form.choice("公式利用枠が回復したとき", manualOnly ? ["手動で再開"] : ["手動で再開", "回復を確認して自動再開"],
                    initial: !manualOnly && values["recovery"] as? String == "confirmed" ? 1 : 0)
    }

    private func researchLimits(_ form: Form, _ values: Record) -> [(String, NSTextField, ClosedRange<Int>)] {
        let limits = [("tokens", "観測トークン合計（0 は無制限）", 0...1_000_000),
                      ("turns", "ターン（0 は無制限）", 0...40),
                      ("jobs", "実験回数（0 は無制限）", 0...20),
                      ("timeout", "実験 1 回の上限秒数", 1...86400)]
        return limits.map { key, title, range in
            (key, form.field(title, (values[key] as? Int).map { String($0) } ?? ""), range)
        }
    }

    private func readLimits(_ fields: [(String, NSTextField, ClosedRange<Int>)]) -> Record? {
        var args: Record = [:]
        for (key, field, range) in fields {
            guard let value = Int(field.stringValue.trimmingCharacters(in: .whitespaces)), range.contains(value) else {
                status.stringValue = "\(field.accessibilityLabel() ?? key) に \(range.lowerBound)〜\(range.upperBound) の整数を入力してください。"
                return nil
            }
            args[key] = value
        }
        return args
    }

    @objc func startResearch() {
        guard let project = selected else { return }
        if isGitHubProject {
            projectRequest("issues") { [weak self] value in
                guard let self, self.selected == project else { return }
                let candidates = (value as? [Record] ?? []).compactMap { issue -> (Int, String)? in
                    guard issue["state"] as? String == "OPEN", let number = issue["number"] as? Int,
                          let title = issue["title"] as? String else { return nil }
                    return (number, "#\(number) · \(title)")
                }
                self.authorizeResearch(candidates, github: true)
            }
        } else {
            authorizeResearch(localTasks(readyOnly: true), github: false)
        }
    }

    private func authorizeResearch(_ candidates: [(id: Int, title: String)], github: Bool) {
        let scopeForm = Form("研究範囲を指定", detail: github
            ? "最近のオープン Issue から選択できます。一覧外は番号を補足してください。"
            : "今回 Developer に任せる課題と作業範囲を指定してください。")
        let selection = scopeForm.checklist("承認する課題", candidates)
        let extra = github ? scopeForm.field("一覧外の Issue 番号（任意、カンマ区切り）") : nil
        let scope = scopeForm.paragraph("研究範囲と制約")
        guard scopeForm.confirm("実行条件へ進む") else { return }
        let parts = split(extra?.stringValue ?? "")
        let additional = parts.compactMap { Int($0) }.filter { $0 > 0 }
        let tasks = Array(Set(selection() + additional)).sorted()
        guard additional.count == parts.count, (1...20).contains(tasks.count),
              !scope.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            status.stringValue = "課題を 1〜20 件指定し、研究範囲を入力してください。"
            return
        }
        confirmResearch(tasks: tasks, scope: scope.string)
    }

    private func split(_ text: String) -> [String] {
        text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }

    private func confirmResearch(tasks: [Int], scope: String) {
        let preset = snapshot["research_preset"] as? Record
        let name = (preset?["name"] as? String)?.capitalized ?? "個別設定"
        let form = Form("研究を開始", detail: "\(name) · 選択した課題 \(tasks.count) 件。下記の上限と実験条件を今回の実行に適用します。")
        let fields = researchLimits(form, preset ?? ["jobs": 4, "turns": 8, "timeout": 120])
        let runtime = form.choice("実験ランタイム", ["Python", "Node.js"])
        let files = form.field("承認する作業ファイル（任意、カンマ区切り）")
        let dependencies = form.field("依存フォルダ（任意）")
        let evidence = form.field("必須成果物（任意、カンマ区切り）")
        guard form.confirm("承認して開始"), var args = readLimits(fields) else { return }
        args["tasks"] = tasks
        args["scope"] = scope
        args["runtime"] = runtime.indexOfSelectedItem == 1 ? "node" : "python"
        args["files"] = split(files.stringValue)
        args["dependencies"] = dependencies.stringValue
        args["evidence"] = split(evidence.stringValue)
        if let name = preset?["name"] as? String {
            args["preset"] = name
            args["recovery"] = preset?["recovery"]
        }
        projectRequest("research-start", args, success: "研究の開始を受け付けました")
    }

    @objc func resumeResearch() {
        guard selected != nil, let fields = form("研究を再開", [
            ("新しい合計予算（0 は無制限、空欄は現在の予算）", ""),
        ]) else { return }
        let input = fields[0].trimmingCharacters(in: .whitespaces)
        if input.isEmpty {
            projectRequest("research-resume", success: "研究の再開を受け付けました")
        } else if let tokens = Int(input), (0...1_000_000).contains(tokens) {
            projectRequest("research-resume", ["tokens": tokens], success: "研究の再開を受け付けました")
        } else {
            status.stringValue = "観測トークン合計は 0〜1,000,000 を指定します（0 は無制限）"
        }
    }
    @objc func stopResearch() { projectRequest("stop", ["role": "developer", "immediate": false], success: "研究の停止を受け付けました") }
    @objc func interruptResearch() { confirmInterrupt("developer") }

}
