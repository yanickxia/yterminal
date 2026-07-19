const MAX_PENDING_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscUpdate {
    Cwd(String),
    Title(String),
    RuntimeStatus(Option<String>),
}

#[derive(Default)]
pub struct OscParser {
    pending: Vec<u8>,
}

impl OscParser {
    /// Observe a raw PTY chunk without changing the bytes written to the
    /// terminal journal. Incomplete OSC sequences are carried into the next
    /// chunk and bounded so malformed output cannot grow memory indefinitely.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<OscUpdate> {
        let mut bytes = std::mem::take(&mut self.pending);
        bytes.extend_from_slice(chunk);
        let mut updates = Vec::new();
        let mut cursor = 0;
        while let Some(relative) = find_subslice(&bytes[cursor..], b"\x1b]") {
            let start = cursor + relative;
            let content_start = start + 2;
            let Some((end, terminator_len)) = find_terminator(&bytes, content_start) else {
                self.pending.extend_from_slice(&bytes[start..]);
                if self.pending.len() > MAX_PENDING_BYTES {
                    let keep_from = self.pending.len() - MAX_PENDING_BYTES;
                    self.pending.drain(..keep_from);
                }
                return updates;
            };
            if let Ok(content) = std::str::from_utf8(&bytes[content_start..end]) {
                if let Some(update) = parse_content(content) {
                    updates.push(update);
                }
            }
            cursor = end + terminator_len;
        }
        // Preserve a trailing ESC in case the `]` arrives in the next chunk.
        if bytes.last() == Some(&0x1b) {
            self.pending.push(0x1b);
        }
        updates
    }
}

fn parse_content(content: &str) -> Option<OscUpdate> {
    let (command, payload) = content.split_once(';')?;
    match command {
        "7" => parse_cwd(payload).map(OscUpdate::Cwd),
        "0" | "2" => {
            let title = sanitize_title(payload);
            (!title.is_empty()).then_some(OscUpdate::Title(title))
        }
        "777" => parse_runtime_status(payload).map(OscUpdate::RuntimeStatus),
        _ => None,
    }
}

fn parse_cwd(payload: &str) -> Option<String> {
    let rest = payload.strip_prefix("file://")?;
    let slash = rest.find('/')?;
    percent_decode(&rest[slash..])
}

fn parse_runtime_status(payload: &str) -> Option<Option<String>> {
    let state = payload.strip_prefix("notify;yt-agent;")?;
    match state {
        "working" | "idle" | "permission" => Some(Some(state.to_string())),
        "ended" => Some(None),
        _ => None,
    }
}

fn sanitize_title(value: &str) -> String {
    value
        .chars()
        .filter(|character| !character.is_control())
        .take(200)
        .collect::<String>()
        .trim()
        .to_string()
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = *bytes.get(index + 1)?;
            let low = *bytes.get(index + 2)?;
            decoded.push((hex(high)? << 4) | hex(low)?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).ok()
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn find_terminator(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    let mut index = start;
    while index < bytes.len() {
        if bytes[index] == 0x07 {
            return Some((index, 1));
        }
        if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
            return Some((index, 2));
        }
        index += 1;
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_split_cwd_title_and_runtime_without_touching_raw_stream() {
        let mut parser = OscParser::default();
        assert!(parser.push(b"text\x1b]7;file://host/home/me%20").is_empty());
        assert_eq!(
            parser.push(b"work\x07\x1b]2;build\x1b\\\x1b]777;notify;yt-agent;working\x07"),
            vec![
                OscUpdate::Cwd("/home/me work".into()),
                OscUpdate::Title("build".into()),
                OscUpdate::RuntimeStatus(Some("working".into())),
            ]
        );
    }

    #[test]
    fn ended_clears_runtime_and_bad_percent_encoding_is_ignored() {
        let mut parser = OscParser::default();
        assert_eq!(
            parser.push(b"\x1b]777;notify;yt-agent;ended\x07\x1b]7;file://h/%XX\x07"),
            vec![OscUpdate::RuntimeStatus(None)]
        );
    }
}
