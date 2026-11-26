import AppKit

@MainActor
final class Form {
    private let alert = NSAlert()
    private let fields = NSStackView()

    init(_ title: String, detail: String = "") {
        alert.messageText = title
        alert.informativeText = detail
        fields.orientation = .vertical
        fields.alignment = .leading
        fields.spacing = 5
    }

    private func add(_ title: String, _ control: NSView) {
        let label = NSTextField(wrappingLabelWithString: title)
        control.setAccessibilityLabel(title)
        for view in [label, control] {
            fields.addArrangedSubview(view)
            view.widthAnchor.constraint(equalToConstant: 480).isActive = true
        }
        fields.setCustomSpacing(12, after: control)
    }

    func field(_ title: String, _ value: String = "") -> NSTextField {
        let field = NSTextField(string: value)
        add(title, field)
        return field
    }

    func paragraph(_ title: String, _ value: String = "") -> NSTextView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 480, height: 68))
        text.font = .systemFont(ofSize: 13)
        text.string = value
        text.isRichText = false
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.setAccessibilityLabel(title)
        scroll.documentView = text
        add(title, scroll)
        scroll.heightAnchor.constraint(equalToConstant: 68).isActive = true
        return text
    }

    func choice(_ title: String, _ choices: [String], initial: Int = 0) -> NSPopUpButton {
        let control = NSPopUpButton()
        control.addItems(withTitles: choices)
        control.selectItem(at: initial)
        add(title, control)
        return control
    }

    func checklist(_ title: String, _ choices: [(id: Int, title: String)]) -> () -> [Int] {
        guard !choices.isEmpty else { return { [] } }
        let list = NSStackView()
        list.orientation = .vertical
        list.alignment = .leading
        let boxes = choices.map { choice in
            let box = NSButton(checkboxWithTitle: choice.title, target: nil, action: nil)
            box.lineBreakMode = .byTruncatingTail
            box.toolTip = choice.title
            list.addArrangedSubview(box)
            box.widthAnchor.constraint(lessThanOrEqualToConstant: 450).isActive = true
            return box
        }
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        list.frame = NSRect(origin: .zero, size: list.fittingSize)
        scroll.documentView = list
        add(title, scroll)
        scroll.heightAnchor.constraint(equalToConstant: min(132, list.fittingSize.height + 4)).isActive = true
        return { zip(choices, boxes).compactMap { $1.state == .on ? $0.id : nil } }
    }

    func confirm(_ title: String) -> Bool {
        fields.frame = NSRect(origin: .zero, size: fields.fittingSize)
        alert.accessoryView = fields
        alert.addButton(withTitle: title)
        alert.addButton(withTitle: "キャンセル")
        return alert.runModal() == .alertFirstButtonReturn
    }
}
