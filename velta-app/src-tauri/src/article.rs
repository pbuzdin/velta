// Article opening for a chat card (issue #252). The message is the text;
// the recipient does not fetch the page.
//
// ponytail: tag scan for <p> text, not Readability. First open tag to the
// first close, no nesting. A real HTML parser when a page's opening is the chrome.

pub struct Extracted {
    pub title: String,
    pub opening: String,
}

pub fn extract(html: &str) -> Option<Extracted> {
    let mut title = page_title(html);
    let opening = element_inner(html, "article")
        .and_then(|inner| opening_of(inner, &title))
        .or_else(|| element_inner(html, "main").and_then(|inner| opening_of(inner, &title)))
        .or_else(|| opening_of(html, &title))?;
    if title.is_empty() {
        title = element_text(&strip_noise(html), "h1").unwrap_or_default();
    }
    Some(Extracted { title, opening })
}

fn opening_of(html: &str, title: &str) -> Option<String> {
    let mut paras = paragraphs(&strip_noise(html));
    if let Some(first) = paras.first() {
        if !title.is_empty() && first.eq_ignore_ascii_case(&collapse(title)) {
            paras.remove(0);
        }
    }
    let mut out = String::new();
    for p in paras.iter().take(4) {
        let extra = p.chars().count() + if out.is_empty() { 0 } else { 2 };
        if !out.is_empty() && out.chars().count() + extra > 1200 {
            break;
        }
        if out.is_empty() && p.chars().count() > 1200 {
            out.push_str(&clip(p, 1200));
            break;
        }
        if !out.is_empty() {
            out.push_str("\n\n");
        }
        out.push_str(p);
    }
    if out.chars().count() < 80 { None } else { Some(out) }
}

fn page_title(html: &str) -> String {
    meta_content(html, "og:title")
        .or_else(|| element_text(html, "title"))
        .unwrap_or_default()
}

fn element_text(html: &str, tag: &str) -> Option<String> {
    let text = visible_text(element_inner(html, tag)?);
    if text.is_empty() { None } else { Some(clip(&text, 200)) }
}

fn meta_content(html: &str, name: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for marker in [
        format!("property=\"{name}\""),
        format!("property='{name}'"),
        format!("name=\"{name}\""),
        format!("name='{name}'"),
    ] {
        let mut from = 0;
        while let Some(rel) = lower[from..].find(&marker) {
            let start = from + rel;
            let tag_start = lower[..start].rfind('<').unwrap_or(start);
            let tag_end = lower[start..].find('>').map(|e| start + e).unwrap_or(lower.len());
            if let Some(v) = content_attr(&html[tag_start..tag_end], &lower[tag_start..tag_end]) {
                if !v.is_empty() {
                    return Some(clip(&v, 200));
                }
            }
            from = start + marker.len();
        }
    }
    None
}

fn content_attr(tag: &str, tag_l: &str) -> Option<String> {
    let key = tag_l.find("content=")?;
    let rest = tag.get(key + "content=".len()..)?;
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let after = rest.get(quote.len_utf8()..)?;
    let end = after.find(quote)?;
    Some(collapse(&decode_entities(after[..end].trim())))
}

fn strip_noise(html: &str) -> String {
    let mut s = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "nav", "footer", "header", "aside", "form"] {
        s = cut_element(&s, tag);
    }
    s
}

fn cut_element(html: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut src = html.to_string();
    for _ in 0..200 {
        let lower = src.to_ascii_lowercase();
        let Some(start) = find_tag(&lower, 0, &open) else { return src };
        let after = start + open.len();
        let Some(gt_rel) = lower[after..].find('>') else { return src };
        let gt = after + gt_rel;
        let next = if lower[..gt].ends_with('/') {
            format!("{}{}", &src[..start], &src[gt + 1..])
        } else {
            let Some(close_at) = find_close_at(&lower, gt + 1, &close) else {
                return src[..start].to_string();
            };
            let Some(end) = lower[close_at..].find('>').map(|e| close_at + e + 1) else {
                return src[..start].to_string();
            };
            if end <= start {
                return src;
            }
            format!("{}{}", &src[..start], &src[end..])
        };
        if next.len() >= src.len() {
            return src;
        }
        src = next;
    }
    src
}

fn element_inner<'a>(html: &'a str, tag: &str) -> Option<&'a str> {
    let lower = html.to_ascii_lowercase();
    let open = format!("<{tag}");
    let start = find_tag(&lower, 0, &open)?;
    let after = start + open.len();
    let gt = after + lower[after..].find('>')?;
    if lower[..gt].ends_with('/') {
        return Some("");
    }
    let close_at = find_close_at(&lower, gt + 1, &format!("</{tag}"))?;
    Some(&html[gt + 1..close_at])
}

/// Index of the `<` that starts `</tag`, or None.
fn find_close_at(lower: &str, from: usize, close: &str) -> Option<usize> {
    let mut i = from;
    while i < lower.len() {
        let rel = lower[i..].find(close)?;
        let start = i + rel;
        let after = start + close.len();
        let ok = lower.as_bytes().get(after).is_some_and(|b| b.is_ascii_whitespace() || *b == b'>');
        if ok {
            return Some(start);
        }
        i = after.max(i + 1);
    }
    None
}

fn find_tag(lower: &str, from: usize, open: &str) -> Option<usize> {
    let mut i = from;
    while i < lower.len() {
        let rel = lower[i..].find(open)?;
        let start = i + rel;
        let after = start + open.len();
        let ok = lower.as_bytes().get(after).is_some_and(|b| {
            b.is_ascii_whitespace() || *b == b'>' || *b == b'/'
        });
        if ok {
            return Some(start);
        }
        i = after.max(i + 1);
    }
    None
}

fn paragraphs(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut out = Vec::new();
    let mut i = 0;
    while out.len() < 5 {
        let Some(start) = find_tag(&lower, i, "<p") else { break };
        let after = start + 2;
        let Some(gt_rel) = lower[after..].find('>') else { break };
        let from = after + gt_rel + 1;
        if lower[start..from].trim_end_matches('>').trim_end().ends_with('/') {
            i = from;
            continue;
        }
        let end = find_close_at(&lower, from, "</p")
            .or_else(|| find_tag(&lower, from, "<p"))
            .unwrap_or(html.len());
        let text = visible_text(&html[from..end]);
        if text.chars().count() >= 40 && !is_url_only(&text) {
            out.push(text);
        }
        let next = if end > from { end } else { from + 1 };
        if next <= start {
            break;
        }
        i = next;
    }
    out
}

fn is_url_only(s: &str) -> bool {
    (s.starts_with("https://") || s.starts_with("http://")) && !s.chars().any(char::is_whitespace)
}

fn visible_text(fragment: &str) -> String {
    let lower = fragment.to_ascii_lowercase();
    let bytes = fragment.as_bytes();
    let mut raw = String::new();
    let mut i = 0;
    while i < fragment.len() {
        if bytes[i] == b'<' {
            if lower[i..].starts_with("<br") {
                let after = i + 3;
                let ok = lower.as_bytes().get(after).is_some_and(|b| {
                    b.is_ascii_whitespace() || *b == b'>' || *b == b'/'
                });
                if ok {
                    raw.push(' ');
                }
            }
            if let Some(gt) = lower[i..].find('>') {
                i += gt + 1;
                continue;
            }
        }
        let ch = fragment[i..].chars().next().unwrap();
        raw.push(ch);
        i += ch.len_utf8();
    }
    collapse(&decode_entities(&raw))
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let Some(end) = rest.find(';') else {
            out.push_str(rest);
            return out;
        };
        if end == 0 || end > 32 {
            out.push('&');
            rest = &rest[1..];
            continue;
        }
        if let Some(ch) = entity(&rest[1..end]) {
            out.push(ch);
            rest = &rest[end + 1..];
        } else {
            out.push('&');
            rest = &rest[1..];
        }
    }
    out.push_str(rest);
    out
}

fn entity(body: &str) -> Option<char> {
    if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
        return char::from_u32(u32::from_str_radix(hex, 16).ok()?).filter(|c| !c.is_control());
    }
    if let Some(dec) = body.strip_prefix('#') {
        return char::from_u32(dec.parse().ok()?).filter(|c| !c.is_control());
    }
    Some(match body {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "hellip" => '\u{2026}',
        "rsquo" => '\u{2019}',
        "lsquo" => '\u{2018}',
        "rdquo" => '\u{201D}',
        "ldquo" => '\u{201C}',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_opening_and_skips_script() {
        let html = r#"<!doctype html><html><head>
            <meta property="og:title" content="Hello &amp; Co and the long title of this piece">
            <title>Ignored</title>
            </head><body>
            <nav><p>This navigation paragraph is long enough that it would pollute the opening if nav were kept in the extract.</p></nav>
            <article>
              <p>Hello &amp; Co and the long title of this piece</p>
              <p>https://example.com/only</p>
              <p>Too short.</p>
              <p>This opening paragraph is definitely long enough to count as article text for the reader today.</p>
              <script>secret script that must not appear in the opening at all please</script>
              <p>The second paragraph continues the piece and should be included in the opening snapshot.</p>
            </article>
            </body></html>"#;
        let a = extract(html).expect("article");
        assert_eq!(a.title, "Hello & Co and the long title of this piece");
        assert!(a.opening.contains("opening paragraph"), "{}", a.opening);
        assert!(a.opening.contains("second paragraph"), "{}", a.opening);
        assert!(!a.opening.contains("secret"), "{}", a.opening);
        assert!(!a.opening.contains("navigation"), "{}", a.opening);
        assert!(!a.opening.contains("https://"), "{}", a.opening);
        assert!(!a.opening.contains("long title"), "{}", a.opening);
    }

    #[test]
    fn short_or_empty_body_is_none() {
        assert!(extract("<html><body><p>Hi</p></body></html>").is_none());
        assert!(extract("<html><body><script>long text that is not an article body and must not be sent as a card to anyone reading</script></body></html>").is_none());
    }

    #[test]
    fn h1_outside_header_when_untitled() {
        let html = "<body><header><h1>Chrome</h1></header><article><h1>Real title</h1><p>This paragraph is the article body and it is long enough to be kept as the opening.</p></article></body>";
        let a = extract(html).expect("article");
        assert_eq!(a.title, "Real title");
        assert!(a.opening.contains("article body"), "{}", a.opening);
    }
}
