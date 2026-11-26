pub fn title_status(kind: &str, title: &str) -> &'static str {
    if kind == "codex" && title.to_ascii_lowercase().contains("action required") {
        return "permission";
    }
    let first = title.chars().next();
    if kind == "claude" {
        if matches!(first, Some('\u{2800}'..='\u{28ff}' | '◐'..='◓'))
            && title.chars().nth(1).is_some_and(char::is_whitespace)
        {
            return "working";
        }
        if title.starts_with("✳ ") {
            return "idle";
        }
    }
    if kind == "codex"
        && title.split_whitespace().any(|word| {
            word.chars().count() == 1 && word.chars().all(|ch| "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏".contains(ch))
        })
    {
        return "working";
    }
    "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_are_agent_specific_and_need_explicit_evidence() {
        assert_eq!(title_status("claude", "⠋ Implementing auth"), "working");
        assert_eq!(title_status("claude", "◐ Implementing auth"), "working");
        assert_eq!(title_status("claude", "✳ Done"), "idle");
        assert_eq!(title_status("codex", "Codex ⠙ Fix tests"), "working");
        assert_eq!(title_status("codex", "Action Required"), "permission");
        assert_eq!(title_status("opencode", "Action Required"), "unknown");
        assert_eq!(title_status("codex", "~/codex/project"), "unknown");
        assert_eq!(title_status("claude", ""), "unknown");
    }
}
