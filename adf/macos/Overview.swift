import Foundation

enum Overview {
    static func decode(_ value: Any?) -> Record {
        guard let raw = value as? String else { return [:] }
        return (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? Record ?? [:]
    }

    static func state(_ session: Record, run: Record = [:], job: Record? = nil, approval: Bool = false) -> String {
        let state = session["state"] as? String ?? ""
        if approval && state == "paused" { return "GitHub 承認待ち" }
        switch state {
        case "running": return "推論中・開始処理中"
        case "waiting":
            if run["state"] as? String == "queued" { return "課題待機" }
            return job == nil ? "実験結果の処理待ち" : "実験中"
        case "quota": return "公式利用枠の回復待ち"
        case "paused":
            switch run["state"] as? String {
            case "completed": return "研究完了"
            case "blocked": return "研究課題が保留"
            default: return "停止中"
            }
        case "interrupted": return "中断・確認が必要"
        case "draining": return "区切りまで実行して停止"
        case "stopping": return "中断処理中"
        case "idle": return "指示待ち"
        default: return state.isEmpty ? "未開始" : state
        }
    }

    static func next(_ state: String, recovery: String, hasResearch: Bool) -> String {
        switch state {
        case "GitHub 承認待ち": return "「GitHub Issues」→「承認待ち」で操作内容を確認してください。"
        case "公式利用枠の回復待ち":
            return recovery == "confirmed"
                ? "公式の回復を確認できれば自動再開します。回復状況は「利用枠を取得」で確認できます。"
                : "公式利用枠が回復したら再開してください。"
        case "実験中": return "実験終了後に同じ Developer スレッドで結果を評価します。"
        case "課題待機": return "承認済み課題が着手可能になるまで待機します。待機中に推論は発生しません。"
        case "停止中", "中断・確認が必要":
            return hasResearch ? "状況を確認し「研究を再開」を選んでください。" : "状況を確認し「再開」を選んでください。"
        case "研究完了": return "成果物と利用量を確認できます。"
        case "研究課題が保留": return "保留理由を確認し、受け入れ条件を見直してください。"
        default: return ""
        }
    }

    static func recovery(_ value: Any?) -> String {
        switch value as? String {
        case "confirmed": return "回復確認後に自動再開"
        case "manual": return "手動で再開"
        default: return "ロール設定"
        }
    }

    static func taskState(_ value: Any?) -> String {
        switch value as? String {
        case "ready": return "未完了"
        case "completed": return "完了"
        case "blocked": return "保留"
        default: return "状態不明"
        }
    }

    static func jobState(_ value: Any?) -> String {
        switch value as? String {
        case "running": return "実行中"
        case "succeeded": return "成功"
        case "failed": return "失敗"
        case "cancelled": return "キャンセル"
        case "interrupted": return "中断"
        default: return "状態不明"
        }
    }

    static func quota(_ response: Record) -> String {
        let buckets = response["rateLimitsByLimitId"] as? [String: Record] ?? [:]
        let fallback = response["rateLimits"] as? Record ?? [:]
        let windows = (buckets.isEmpty ? ["codex": fallback] : buckets).sorted { $0.key < $1.key }
        let entries = windows.flatMap { name, bucket in
            [("primary", "主枠"), ("secondary", "副枠")].compactMap { key, title -> String? in
                guard let window = bucket[key] as? Record, let used = window["usedPercent"] as? Double,
                      used.isFinite else { return nil }
                let duration = (window["windowDurationMins"] as? Int).map { "（\($0)分）" } ?? ""
                let reset = (window["resetsAt"] as? Double).map {
                    " · 回復予定 " + Date(timeIntervalSince1970: $0).formatted(date: .abbreviated, time: .shortened)
                } ?? ""
                return "\(name) \(title)\(duration) 使用 \(used.formatted())%\(reset)"
            }
        }
        return entries.isEmpty ? "公式利用枠を取得できませんでした" : entries.joined(separator: "\n")
    }
}
