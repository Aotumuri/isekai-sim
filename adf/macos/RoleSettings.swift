import AppKit

@MainActor
extension Desktop {
    @objc func settings() {
        let form = Form("ロール設定", detail: "設定はすべてのプロジェクトで同じロールに適用されます。")
        let names = records("roles").compactMap { $0["name"] as? String }
        guard !names.isEmpty else { return }
        let choice = form.choice("設定するロール", names + ["新しいロール"], initial: names.firstIndex(of: role) ?? 0)
        guard form.confirm("モデルを選ぶ") else { return }
        let name = names.indices.contains(choice.indexOfSelectedItem) ? names[choice.indexOfSelectedItem] : ""
        let value = records("roles").first { $0["name"] as? String == name } ?? [:]
        request("models") { [weak self] models in
            self?.editRole(name, value: value, models: models as? [Record] ?? [])
        } failed: { [weak self] in
            self?.editRole(name, value: value, models: [])
        }
    }

    private func editRole(_ name: String, value: Record, models: [Record]) {
        let saved = value["model"] as? String ?? ""
        let options = [""] + models.compactMap { $0["model"] as? String }
        let choices = options.contains(saved) ? options : options + [saved]
        let form = Form("モデルを選択", detail: models.isEmpty
                        ? "モデル一覧を取得できませんでした。既定値、保存済みの値、直接入力を選べます。"
                        : "既定値は Codex の設定に従います。")
        let model = form.choice("モデル", ["Codex の既定"] + Array(choices.dropFirst()) + ["直接入力"],
                                initial: choices.firstIndex(of: saved) ?? 0)
        guard form.confirm("ロール設定へ進む") else { return }
        let custom = model.indexOfSelectedItem == choices.count
        let chosen = custom ? saved : choices[model.indexOfSelectedItem]
        let catalog = models.first { ($0["model"] as? String) == chosen }
        saveRole(name, value: value, chosen: chosen, catalog: catalog, custom: custom)
    }

    private func saveRole(_ name: String, value: Record, chosen: String, catalog: Record?, custom: Bool) {
        let form = Form(name.isEmpty ? "ロールを追加" : "\(name) の設定",
                        detail: "モデル · \(chosen.isEmpty ? "Codex の既定" : chosen)")
        let newName = name.isEmpty ? form.field("新しいロールの識別名") : nil
        let model = custom ? form.field("モデル識別名", chosen) : nil
        let saved = value["effort"] as? String ?? ""
        let allowed = (catalog?["supportedReasoningEfforts"] as? [Record])?.compactMap { $0["reasoningEffort"] as? String }
        let options = [""] + (allowed ?? ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        let preserve = chosen == (value["model"] as? String ?? "") && !options.contains(saved)
        let choices = preserve ? options + [saved] : options
        let effort = form.choice("推論強度", ["Codex の既定"] + Array(choices.dropFirst()),
                                 initial: choices.firstIndex(of: saved) ?? 0)
        let instructions = form.paragraph("追加指示", value["instructions"] as? String ?? "")
        let recovery = recoveryChoice(form, value)
        let budget = form.field("ロールの累計トークン予算（0 は無制限）", String(value["budget"] as? Int ?? 0))
        guard form.confirm("ロール設定を保存") else { return }
        guard let maxTokens = Int(budget.stringValue), maxTokens >= 0 else {
            status.stringValue = "ロールの累計トークン予算には 0 以上の整数を指定してください。"
            return
        }
        request("role", ["name": newName?.stringValue ?? name, "instructions": instructions.string,
                         "model": model?.stringValue ?? chosen, "effort": choices[effort.indexOfSelectedItem],
                         "recovery": recovery.indexOfSelectedItem == 1 ? "confirmed" : "manual", "budget": maxTokens],
                success: "ロール設定を保存しました")
    }

}
