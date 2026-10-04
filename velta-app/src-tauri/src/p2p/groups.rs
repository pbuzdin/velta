//! Local group chats (≤ 5 members): creator-signed membership state, its
//! validation, and the per-group records persisted in `groups.json`.
//!
//! Pure data + crypto, no networking: `p2p.rs` wires it into the engine. A
//! group has exactly one signer, its creator; every membership change is a
//! new `GroupState` with a higher `epoch`, signed with the creator's identity
//! key. Anyone may relay a state, receivers verify the signature against the
//! creator's node id that they already hold, so relayed rosters are as
//! trustworthy as ones received from the creator.

use std::{collections::{BTreeMap, HashMap}, net::SocketAddr, path::Path, str::FromStr};

use anyhow::{anyhow, bail, Context as _, Result};
use data_encoding::HEXLOWER;
use iroh::{NodeId, SecretKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};

/// A local group holds at most this many members, the creator included.
pub const MAX_GROUP_MEMBERS: usize = 5;
/// The cap of v1.4.56/57: those builds reject a roster above this, silently
/// (they cannot be told apart from a current build by protocol number, so
/// bigger groups are offered only after every member announced
/// [`MAX_GROUP_MEMBERS`] in a `GroupCaps` frame).
pub const LEGACY_MAX_GROUP_MEMBERS: usize = 4;
/// Groups per device (created or joined), so a paired peer cannot flood us.
pub const MAX_GROUPS: usize = 16;
/// Longest group / member display name, in characters.
pub const MAX_NAME_CHARS: usize = 64;
/// Advisory addresses per member in a state.
pub const MAX_MEMBER_ADDRS: usize = 3;
/// Domain separation prefix of the signed bytes.
const STATE_DOMAIN: &[u8] = b"velta-group-state-v1\0";

/// One roster entry. `addrs` are advisory (they change with DHCP and any
/// member may refresh them when relaying) and are NOT covered by the
/// signature; names are, so a relaying member cannot rename others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupMember {
    pub node_id: String,
    pub name: String,
    #[serde(default)]
    pub addrs: Vec<String>,
}

/// The signed membership state (wire format and `groups.json`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupState {
    /// 16 random bytes, lowercase hex (32 chars): also a file-name component.
    pub gid: String,
    /// Immutable signer; always `members[0]`.
    pub creator: String,
    /// Monotonic, owned by the creator: create = 1, every change +1.
    pub epoch: u64,
    pub name: String,
    /// The creator disbanded the group (then `members` is just the creator).
    #[serde(default)]
    pub closed: bool,
    pub members: Vec<GroupMember>,
    /// Hex ed25519 signature by `creator` over [`GroupState::sign_bytes`].
    #[serde(default)]
    pub sig: String,
}

/// Canonical form of a node id: what `NodeId` prints, so two spellings of one
/// key (upper/lower case hex) cannot count as two members.
fn canonical_node(s: &str) -> Result<NodeId> {
    let id = NodeId::from_str(s).map_err(|_| anyhow!("bad node id"))?;
    if id.to_string() != s {
        bail!("node id is not in canonical form");
    }
    Ok(id)
}

fn check_name(what: &str, name: &str, allow_empty: bool) -> Result<()> {
    if name.is_empty() && !allow_empty {
        bail!("{what} must not be empty");
    }
    if name.chars().count() > MAX_NAME_CHARS {
        bail!("{what} is longer than {MAX_NAME_CHARS} characters");
    }
    Ok(())
}

/// Validates a group name typed by the user (creator side).
pub fn check_group_name(name: &str) -> Result<()> {
    check_name("group name", name, false)
}

/// Fresh group id.
pub fn new_gid() -> String {
    let mut b = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut b);
    HEXLOWER.encode(&b)
}

impl GroupState {
    /// Bytes covered by the signature:
    /// `domain || gid(16) || epoch(u64 BE) || closed(u8) || len16(name)||name
    ///  || n(u8) || for each member in order: node_id(32) || len16(name)||name`.
    pub fn sign_bytes(&self) -> Result<Vec<u8>> {
        let gid = HEXLOWER.decode(self.gid.as_bytes()).context("bad gid")?;
        if gid.len() != 16 {
            bail!("gid must be 16 bytes");
        }
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(STATE_DOMAIN);
        out.extend_from_slice(&gid);
        out.extend_from_slice(&self.epoch.to_be_bytes());
        out.push(self.closed as u8);
        push_str(&mut out, &self.name)?;
        out.push(u8::try_from(self.members.len()).context("too many members")?);
        for m in &self.members {
            out.extend_from_slice(canonical_node(&m.node_id)?.as_bytes());
            push_str(&mut out, &m.name)?;
        }
        Ok(out)
    }

    /// Signs with the creator's identity key (must match `creator`).
    pub fn sign(&mut self, secret: &SecretKey) -> Result<()> {
        if secret.public().to_string() != self.creator {
            bail!("only the creator can sign a group state");
        }
        self.sig = HEXLOWER.encode(&secret.sign(&self.sign_bytes()?).to_bytes());
        Ok(())
    }

    /// Verifies the signature against `creator`'s key.
    pub fn verify_signature(&self) -> Result<()> {
        let creator = canonical_node(&self.creator)?;
        let raw = HEXLOWER.decode(self.sig.as_bytes()).context("bad signature encoding")?;
        // `iroh` does not re-export the signature type; its `TryFrom<&[u8]>`
        // (64 bytes) is inferred from `verify`'s parameter.
        let sig = raw.as_slice().try_into().map_err(|_| anyhow!("signature must be 64 bytes"))?;
        creator
            .verify(&self.sign_bytes()?, &sig)
            .map_err(|_| anyhow!("group state signature does not verify"))
    }

    /// Structural limits, enforced on EVERY state we accept regardless of who
    /// relays it (a hostile or buggy creator cannot push a 5-member group).
    pub fn validate(&self) -> Result<()> {
        let gid = HEXLOWER.decode(self.gid.as_bytes()).map_err(|_| anyhow!("bad gid"))?;
        if gid.len() != 16 || !super::is_safe_transfer_id(&self.gid) {
            bail!("bad gid");
        }
        let creator = canonical_node(&self.creator).context("bad creator")?;
        if self.epoch == 0 {
            bail!("epoch must be at least 1");
        }
        check_name("group name", &self.name, false)?;
        if self.members.is_empty() || self.members.len() > MAX_GROUP_MEMBERS {
            bail!("a local group holds 1 to {MAX_GROUP_MEMBERS} members");
        }
        let mut seen = Vec::with_capacity(self.members.len());
        for m in &self.members {
            let id = canonical_node(&m.node_id).context("bad member id")?;
            if seen.contains(&id) {
                bail!("duplicate member");
            }
            seen.push(id);
            check_name("member name", &m.name, true)?;
            if m.addrs.len() > MAX_MEMBER_ADDRS {
                bail!("too many addresses for one member");
            }
            for a in &m.addrs {
                a.parse::<SocketAddr>().map_err(|_| anyhow!("bad member address"))?;
            }
        }
        if seen[0] != creator {
            bail!("the creator must be the first member");
        }
        if self.closed && self.members.len() != 1 {
            bail!("a closed group lists only its creator");
        }
        Ok(())
    }

    /// `validate` + signature: the full acceptance test for a received state.
    pub fn check(&self) -> Result<()> {
        self.validate()?;
        self.verify_signature()
    }

    pub fn contains(&self, node: &NodeId) -> bool {
        let s = node.to_string();
        self.members.iter().any(|m| m.node_id == s)
    }
}

fn push_str(out: &mut Vec<u8>, s: &str) -> Result<()> {
    let len = u16::try_from(s.len()).context("name too long")?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(s.as_bytes());
    Ok(())
}

/// Local per-group record (one entry of `groups.json`). The cursor fields are
/// carried now so the message phase needs no file migration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupRec {
    pub state: GroupState,
    /// I was removed / left / the group was closed: read-only, history kept.
    #[serde(default)]
    pub removed: bool,
    /// My next outgoing seq.
    #[serde(default = "one")]
    pub next_seq: u64,
    /// member -> highest of MY seqs they cumulatively acked.
    #[serde(default)]
    pub sent_cursor: HashMap<String, u64>,
    /// author -> highest contiguous seq I stored from them.
    #[serde(default)]
    pub have: HashMap<String, u64>,
    /// member -> last epoch confirmed delivered (creator only).
    #[serde(default)]
    pub state_cursor: HashMap<String, u64>,
    /// I left; tell the creator when reachable.
    #[serde(default)]
    pub pending_leave: bool,
    /// The user deleted the chat. Kept only while `pending_leave` is still
    /// undelivered (so the creator still hears about it); never listed.
    #[serde(default)]
    pub hidden: bool,
}

fn one() -> u64 {
    1
}

impl GroupRec {
    pub fn new(state: GroupState) -> Self {
        GroupRec {
            state,
            removed: false,
            next_seq: 1,
            sent_cursor: HashMap::new(),
            have: HashMap::new(),
            state_cursor: HashMap::new(),
            pending_leave: false,
            hidden: false,
        }
    }
}

/// What a received state means for the local record.
#[derive(Debug, PartialEq, Eq)]
pub enum Evaluation {
    /// Epoch is not newer than what we hold: harmless replay, ignore.
    Stale,
    /// Unknown group that includes this device.
    Create,
    /// Newer state for a known group; `removed_me` when this device is no
    /// longer listed (or the group was closed).
    Update { removed_me: bool },
}

/// Decides what to do with `incoming`, given the local record (if any).
/// Does not look at WHO sent it: that is the caller's rule (first contact
/// only from the paired creator, updates from members).
pub fn evaluate_incoming(local: Option<&GroupRec>, incoming: &GroupState, me: &NodeId) -> Result<Evaluation> {
    incoming.check()?;
    match local {
        None => {
            if incoming.closed {
                bail!("closed state for an unknown group");
            }
            if !incoming.contains(me) {
                bail!("group does not include this device");
            }
            Ok(Evaluation::Create)
        }
        Some(rec) => {
            if rec.state.creator != incoming.creator {
                bail!("group creator mismatch");
            }
            if incoming.epoch <= rec.state.epoch {
                return Ok(Evaluation::Stale);
            }
            Ok(Evaluation::Update { removed_me: incoming.closed || !incoming.contains(me) })
        }
    }
}

// ---------------------------------------------------------------------------
// groups.json
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
struct GroupsFile {
    groups: Vec<GroupRec>,
}

fn groups_path(dir: &Path) -> std::path::PathBuf {
    dir.join("groups.json")
}

/// Loads `groups.json`. Records whose state does not pass the full check
/// (hand-edited, truncated, forged) are dropped; a file that does not parse
/// at all is moved aside to `groups.json.corrupt` instead of being lost.
pub fn load_groups(dir: &Path) -> BTreeMap<String, GroupRec> {
    let mut out = BTreeMap::new();
    let Ok(data) = std::fs::read(groups_path(dir)) else {
        return out;
    };
    let Ok(file) = serde_json::from_slice::<GroupsFile>(&data) else {
        let _ = std::fs::rename(groups_path(dir), dir.join("groups.json.corrupt"));
        return out;
    };
    for rec in file.groups {
        if out.len() >= MAX_GROUPS || out.contains_key(&rec.state.gid) || rec.state.check().is_err() {
            continue;
        }
        out.insert(rec.state.gid.clone(), rec);
    }
    out
}

/// Rewrites `groups.json` atomically (tmp + rename). The file is small.
pub fn save_groups(dir: &Path, groups: &BTreeMap<String, GroupRec>) -> Result<()> {
    let file = GroupsFile { groups: groups.values().cloned().collect() };
    let tmp = dir.join("groups.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&file)?)?;
    std::fs::rename(&tmp, groups_path(dir))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Message log: messages-g-<gid>.jsonl (append-only)
// ---------------------------------------------------------------------------

/// Longest group message text (same bound as 1:1).
pub const MAX_GROUP_TEXT: usize = 64 * 1024;

/// One line of a group's message log. Delivery state is NOT stored here: it
/// is derived from `GroupRec::sent_cursor`, so the log never needs rewriting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupLogRec {
    pub seq: u64,
    /// Author node id.
    pub from: String,
    /// Random id (quote target); `(from, seq)` is the real identity.
    pub id: String,
    /// The author's timestamp, as sent.
    pub ts: u64,
    /// Display timestamp: never earlier than the previous record's, never in
    /// the future ([`eff_ts`]).
    pub ts_eff: u64,
    /// "in" or "out".
    pub dir: String,
    pub text: String,
    #[serde(default)]
    pub reply_to: Option<String>,
    #[serde(default)]
    pub reply_text: Option<String>,
    /// A media message (`text` is its caption). File messages are not part of
    /// the author's seq stream: `seq` is 0, `id` is the transfer id and the
    /// identity is `(from, id)`. They are delivered live to online members
    /// only, never replayed, and counted by nothing (like system lines).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<GroupFileRec>,
}

/// Where a group media file lives on this device.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupFileRec {
    pub name: String,
    pub size: u64,
    pub mime: String,
    pub path: String,
}

/// `dir` of a system line ("X added Y", "Z left", ...). These are written by
/// the device that observes the change; they carry no author and no seq, are
/// never replicated, replayed or counted (`scan_log` ignores them).
pub const SYS_DIR: &str = "sys";

/// What changed between two states of one group, as seen by a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RosterEvent {
    Added(String),
    Removed(String),
    Renamed(String),
    Disbanded,
}

/// Differences `old -> new`. A disband reports only `Disbanded` (the roster
/// shrinking to the creator is part of it, not a bunch of removals).
pub fn roster_events(old: &GroupState, new: &GroupState) -> Vec<RosterEvent> {
    let mut out = Vec::new();
    if new.closed && !old.closed {
        return vec![RosterEvent::Disbanded];
    }
    if new.name != old.name {
        out.push(RosterEvent::Renamed(new.name.clone()));
    }
    for m in &new.members {
        if !old.members.iter().any(|o| o.node_id == m.node_id) {
            out.push(RosterEvent::Added(m.node_id.clone()));
        }
    }
    for m in &old.members {
        if !new.members.iter().any(|n| n.node_id == m.node_id) {
            out.push(RosterEvent::Removed(m.node_id.clone()));
        }
    }
    out
}

/// A system line for the log. `id` is `sys:<kind>:<epoch>:<index>` (unique per
/// line, and the UI's key); `kind` is one of created / joined / added /
/// removed / left / gone / renamed / disbanded / removed-me / left-me.
pub fn sys_rec(kind: &str, epoch: u64, index: usize, text: String, ts_eff: u64) -> GroupLogRec {
    GroupLogRec {
        seq: 0,
        from: String::new(),
        id: format!("sys:{kind}:{epoch}:{index}"),
        ts: ts_eff,
        ts_eff,
        dir: SYS_DIR.into(),
        text,
        reply_to: None,
        reply_text: None,
        file: None,
    }
}

/// The `kind` part of a system line's id.
pub fn sys_kind(id: &str) -> Option<&str> {
    id.strip_prefix("sys:")?.split(':').next()
}

/// Deletes a group's message log (missing file is fine).
pub fn delete_log(dir: &Path, gid: &str) {
    let _ = std::fs::remove_file(log_path(dir, gid));
}

/// `max(previous display ts, min(author ts, now))`: non-decreasing, so clock
/// skew cannot create backwards times or duplicate day chips.
pub fn eff_ts(prev: u64, author_ts: u64, now: u64) -> u64 {
    prev.max(author_ts.min(now))
}

fn log_path(dir: &Path, gid: &str) -> std::path::PathBuf {
    // gid is a validated 32-char hex string wherever a GroupRec exists.
    dir.join(format!("messages-g-{gid}.jsonl"))
}

/// Appends one record (a single `write_all` of one line).
pub fn append_log(dir: &Path, gid: &str, rec: &GroupLogRec) -> Result<()> {
    use std::io::Write;
    let mut line = serde_json::to_vec(rec)?;
    line.push(b'\n');
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log_path(dir, gid))?;
    f.write_all(&line)?;
    Ok(())
}

/// Every parsable record, oldest first (a torn last line is skipped).
pub fn read_log(dir: &Path, gid: &str) -> Vec<GroupLogRec> {
    let Ok(data) = std::fs::read_to_string(log_path(dir, gid)) else {
        return Vec::new();
    };
    data.lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// The last `limit` records, oldest first.
pub fn load_group_log(dir: &Path, gid: &str, limit: usize) -> Vec<GroupLogRec> {
    let mut all = read_log(dir, gid);
    let start = all.len().saturating_sub(limit);
    all.drain(..start);
    all
}

/// What the log says about counters, used to repair `groups.json` after a
/// crash between "log line written" and "counter persisted".
#[derive(Debug, Default, PartialEq, Eq)]
pub struct LogScan {
    /// Highest seq I authored (`next_seq` is at least this + 1).
    pub own_max: u64,
    /// Highest seq stored per author (`have` is at least this).
    pub in_max: HashMap<String, u64>,
    pub last_ts_eff: u64,
}

pub fn scan_log(dir: &Path, gid: &str, me: &str) -> LogScan {
    let mut scan = LogScan::default();
    for r in read_log(dir, gid) {
        if r.from == me && r.dir == "out" {
            scan.own_max = scan.own_max.max(r.seq);
        } else if r.dir == "in" {
            let e = scan.in_max.entry(r.from).or_insert(0);
            *e = (*e).max(r.seq);
        }
        scan.last_ts_eff = scan.last_ts_eff.max(r.ts_eff);
    }
    scan
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn key() -> SecretKey {
        let mut b = [0u8; 32];
        rand::rngs::OsRng.fill_bytes(&mut b);
        SecretKey::from_bytes(&b)
    }

    fn member(k: &SecretKey, name: &str) -> GroupMember {
        GroupMember { node_id: k.public().to_string(), name: name.into(), addrs: vec!["192.168.1.5:4000".into()] }
    }

    /// A signed 3-member group; returns the creator key too.
    fn signed(n: usize) -> (SecretKey, Vec<SecretKey>, GroupState) {
        let creator = key();
        let others: Vec<SecretKey> = (1..n).map(|_| key()).collect();
        let mut members = vec![member(&creator, "Creator")];
        members.extend(others.iter().enumerate().map(|(i, k)| member(k, &format!("M{i}"))));
        let mut st = GroupState {
            gid: new_gid(), creator: creator.public().to_string(), epoch: 1,
            name: "Weekend".into(), closed: false, members, sig: String::new(),
        };
        st.sign(&creator).unwrap();
        (creator, others, st)
    }

    #[test]
    fn group_state_sign_verify_roundtrip() {
        let (creator, _, st) = signed(3);
        st.check().unwrap();
        // Survives the wire (JSON) unchanged.
        let again: GroupState = serde_json::from_str(&serde_json::to_string(&st).unwrap()).unwrap();
        assert_eq!(again, st);
        again.check().unwrap();
        // Addresses are advisory: any relaying member may refresh them.
        let mut relayed = st.clone();
        relayed.members[1].addrs = vec!["10.0.0.9:1".into()];
        relayed.check().unwrap();
        // Only the creator signs.
        let mut other = st.clone();
        assert!(other.sign(&key()).is_err());
        // A re-sign with the creator's key at a new epoch verifies; the old sig does not carry over.
        let mut next = st.clone();
        next.epoch = 2;
        assert!(next.verify_signature().is_err());
        next.sign(&creator).unwrap();
        next.check().unwrap();
    }

    #[test]
    fn group_state_tampered_member_or_name_fails_verify() {
        let (_, _, st) = signed(3);
        let tamper: Vec<(&str, Box<dyn Fn(&mut GroupState)>)> = vec![
            ("group name", Box::new(|s| s.name = "Hijacked".into())),
            ("member name", Box::new(|s| s.members[1].name = "Mallory".into())),
            ("member id", Box::new(|s| s.members[2].node_id = key().public().to_string())),
            ("member order", Box::new(|s| s.members.swap(1, 2))),
            ("dropped member", Box::new(|s| { s.members.pop(); })),
            ("epoch", Box::new(|s| s.epoch += 1)),
            ("closed flag", Box::new(|s| s.closed = true)),
            ("gid", Box::new(|s| s.gid = new_gid())),
            ("signature bit", Box::new(|s| {
                let mut raw = HEXLOWER.decode(s.sig.as_bytes()).unwrap();
                raw[0] ^= 1;
                s.sig = HEXLOWER.encode(&raw);
            })),
            ("signature garbage", Box::new(|s| s.sig = "zz".into())),
            ("signature missing", Box::new(|s| s.sig.clear())),
        ];
        for (what, f) in tamper {
            let mut t = st.clone();
            f(&mut t);
            assert!(t.verify_signature().is_err(), "tampering with the {what} must fail verification");
        }
        // Re-labelled creator: the signature belongs to the real creator's key.
        let mut stolen = st.clone();
        stolen.creator = stolen.members[1].node_id.clone();
        assert!(stolen.verify_signature().is_err());
        // A member (not the creator) cannot forge a state.
        let (_, others, st2) = signed(3);
        let mut forged = st2.clone();
        forged.epoch = 9;
        forged.sig = HEXLOWER.encode(&others[0].sign(&forged.sign_bytes().unwrap()).to_bytes());
        assert!(forged.verify_signature().is_err());
    }

    #[test]
    fn group_state_validation_rejects_5_members_dupes_missing_creator_long_name() {
        let (_, _, ok) = signed(MAX_GROUP_MEMBERS);
        ok.validate().unwrap(); // exactly the cap is fine
        let bad: Vec<(&str, Box<dyn Fn(&mut GroupState)>)> = vec![
            ("6 members", Box::new(|s| s.members.push(member(&key(), "Sixth")))),
            ("no members", Box::new(|s| s.members.clear())),
            ("duplicate member", Box::new(|s| s.members[2] = s.members[1].clone())),
            ("upper-case alias of a member", Box::new(|s| {
                s.members[2].node_id = s.members[1].node_id.to_uppercase();
            })),
            ("creator missing", Box::new(|s| { s.members.remove(0); })),
            ("creator not first", Box::new(|s| s.members.swap(0, 1))),
            ("empty group name", Box::new(|s| s.name.clear())),
            ("65-char group name", Box::new(|s| s.name = "x".repeat(65))),
            ("65-char member name", Box::new(|s| s.members[1].name = "y".repeat(65))),
            ("4 addrs", Box::new(|s| s.members[1].addrs = vec!["1.1.1.1:1".into(); 4])),
            ("unparsable addr", Box::new(|s| s.members[1].addrs = vec!["not-an-addr".into()])),
            ("epoch 0", Box::new(|s| s.epoch = 0)),
            ("bad gid", Box::new(|s| s.gid = "../etc/passwd".into())),
            ("short gid", Box::new(|s| s.gid = "ab".into())),
            ("bad creator", Box::new(|s| s.creator = "nope".into())),
            ("closed with members", Box::new(|s| s.closed = true)),
        ];
        for (what, f) in bad {
            let mut s = ok.clone();
            f(&mut s);
            assert!(s.validate().is_err(), "{what} must be rejected");
        }
        // 64 characters (multi-byte) are fine; signing stays well-formed.
        let mut long_ok = ok.clone();
        long_ok.name = "ы".repeat(64);
        long_ok.validate().unwrap();
        assert!(check_group_name(&"ы".repeat(65)).is_err());
        assert!(check_group_name("").is_err());
        // A hostile creator that signs a 6-member state is still refused by `check`.
        let (creator, _, mut six) = signed(MAX_GROUP_MEMBERS);
        six.members.push(member(&key(), "Sixth"));
        six.epoch = 2;
        six.sign(&creator).unwrap();
        assert!(six.verify_signature().is_ok(), "signature is fine…");
        assert!(six.check().is_err(), "…the member cap is what rejects it");
        // The biggest legal state (5 members, 64-char multi-byte names, 3 addrs
        // each) is a few KB, far below one frame.
        let (creator, _, mut worst) = signed(MAX_GROUP_MEMBERS);
        for m in worst.members.iter_mut() {
            m.name = "ы".repeat(MAX_NAME_CHARS);
            m.addrs = vec!["[2001:0db8:85a3:0000:0000:8a2e:0370:7334]:65535".into(); MAX_MEMBER_ADDRS];
        }
        worst.name = "ы".repeat(MAX_NAME_CHARS);
        worst.sign(&creator).unwrap();
        worst.check().unwrap();
        let wire = serde_json::to_vec(&serde_json::json!({ "type": "groupstate", "state": worst })).unwrap();
        assert!(wire.len() < 8 * 1024, "{} bytes", wire.len());
        // A closed group lists just its creator.
        let (creator, _, mut closed) = signed(3);
        closed.closed = true;
        closed.members.truncate(1);
        closed.epoch = 2;
        closed.sign(&creator).unwrap();
        closed.check().unwrap();
    }

    #[test]
    fn group_id_is_safe_transfer_id() {
        for _ in 0..50 {
            let gid = new_gid();
            assert_eq!(gid.len(), 32);
            assert!(super::super::is_safe_transfer_id(&gid));
            assert!(gid.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        }
        assert_ne!(new_gid(), new_gid());
    }

    #[test]
    fn evaluate_incoming_epoch_creator_and_membership_rules() {
        let (creator, others, st) = signed(3);
        let me = others[0].public();
        // Unknown group that includes me: create. One that does not: refuse.
        assert_eq!(evaluate_incoming(None, &st, &me).unwrap(), Evaluation::Create);
        assert!(evaluate_incoming(None, &st, &key().public()).is_err());
        let rec = GroupRec::new(st.clone());
        // Same or older epoch: stale (replay / rollback is harmless).
        assert_eq!(evaluate_incoming(Some(&rec), &st, &me).unwrap(), Evaluation::Stale);
        // Newer epoch that drops me: removed.
        let mut next = st.clone();
        next.epoch = 2;
        next.members.remove(1);
        next.sign(&creator).unwrap();
        assert_eq!(evaluate_incoming(Some(&rec), &next, &me).unwrap(), Evaluation::Update { removed_me: true });
        // Rollback after that is stale for the new record.
        let mut rec2 = rec.clone();
        rec2.state = next.clone();
        assert_eq!(evaluate_incoming(Some(&rec2), &st, &me).unwrap(), Evaluation::Stale);
        // Newer epoch signed by somebody else as "creator" of the same gid: refused.
        let impostor = key();
        let mut hostile = st.clone();
        hostile.creator = impostor.public().to_string();
        hostile.members[0].node_id = hostile.creator.clone();
        hostile.epoch = 5;
        hostile.sign(&impostor).unwrap();
        assert!(evaluate_incoming(Some(&rec), &hostile, &me).is_err());
        // A closed state for a group we never had is not a new group.
        let mut closed = st.clone();
        closed.closed = true;
        closed.members.truncate(1);
        closed.epoch = 2;
        closed.sign(&creator).unwrap();
        assert!(evaluate_incoming(None, &closed, &me).is_err());
        // Invalid / unsigned input never reaches the rules.
        let mut unsigned = st.clone();
        unsigned.sig.clear();
        assert!(evaluate_incoming(None, &unsigned, &me).is_err());
    }

    #[test]
    fn groups_json_roundtrip_and_hardening() {
        let dir = std::env::temp_dir().join(format!("velta-groups-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_groups(&dir).is_empty());

        let (_, others, st) = signed(3);
        let mut rec = GroupRec::new(st.clone());
        rec.removed = true;
        rec.next_seq = 7;
        rec.sent_cursor.insert(others[0].public().to_string(), 3);
        rec.have.insert(others[1].public().to_string(), 2);
        rec.pending_leave = true;
        let mut groups = BTreeMap::new();
        groups.insert(st.gid.clone(), rec.clone());
        save_groups(&dir, &groups).unwrap();
        assert!(!dir.join("groups.json.tmp").exists(), "atomic write leaves no temp file");
        let back = load_groups(&dir);
        let r = &back[&st.gid];
        assert_eq!(r.state, st);
        assert!(r.removed && r.pending_leave);
        assert_eq!(r.next_seq, 7);
        assert_eq!(r.sent_cursor, rec.sent_cursor);
        assert_eq!(r.have, rec.have);

        // A record whose signature no longer matches (hand edit) is dropped.
        let mut forged = rec.clone();
        forged.state.name = "Edited by hand".into();
        let (_, _, other) = signed(2);
        let file = GroupsFile { groups: vec![forged, rec.clone(), GroupRec::new(other.clone())] };
        std::fs::write(dir.join("groups.json"), serde_json::to_vec(&file).unwrap()).unwrap();
        let back = load_groups(&dir);
        assert!(back.contains_key(&other.gid));
        assert_eq!(back[&st.gid].state.name, st.name, "the untouched record remains");
        assert_eq!(back.len(), 2);

        // Older files without the optional fields still load.
        let minimal = serde_json::json!({ "groups": [{ "state": other }] });
        std::fs::write(dir.join("groups.json"), minimal.to_string()).unwrap();
        let back = load_groups(&dir);
        assert_eq!(back[&other.gid].next_seq, 1);
        assert!(!back[&other.gid].removed);

        // The load cap holds even for a huge file.
        let many: Vec<GroupRec> = (0..MAX_GROUPS + 5).map(|_| GroupRec::new(signed(2).2)).collect();
        std::fs::write(dir.join("groups.json"), serde_json::to_vec(&GroupsFile { groups: many }).unwrap()).unwrap();
        assert_eq!(load_groups(&dir).len(), MAX_GROUPS);

        // Garbage is moved aside, not silently discarded.
        std::fs::write(dir.join("groups.json"), b"{ not json").unwrap();
        assert!(load_groups(&dir).is_empty());
        assert!(dir.join("groups.json.corrupt").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn roster_events_and_system_lines() {
        let (_, _, st) = signed(3);
        let id = |i: usize| st.members[i].node_id.clone();
        let mut renamed = st.clone();
        renamed.name = "New".into();
        assert_eq!(roster_events(&st, &renamed), vec![RosterEvent::Renamed("New".into())]);
        let mut fewer = st.clone();
        fewer.members.retain(|m| m.node_id != id(2));
        assert_eq!(roster_events(&st, &fewer), vec![RosterEvent::Removed(id(2))]);
        assert_eq!(roster_events(&fewer, &st), vec![RosterEvent::Added(id(2))]);
        let mut closed = st.clone();
        closed.closed = true;
        closed.members.truncate(1);
        assert_eq!(roster_events(&st, &closed), vec![RosterEvent::Disbanded], "a disband is one line, not N removals");
        assert!(roster_events(&st, &st).is_empty());

        // A system line has no author/seq and is invisible to the counters.
        let dir = std::env::temp_dir().join(format!("velta-groupsys-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let r = sys_rec("added", 4, 1, "A added B".into(), 77);
        assert_eq!((r.seq, r.dir.as_str(), r.from.as_str()), (0, "sys", ""));
        assert_eq!(sys_kind(&r.id), Some("added"));
        assert_eq!(sys_kind("abc"), None);
        append_log(&dir, &st.gid, &r).unwrap();
        let scan = scan_log(&dir, &st.gid, &id(0));
        assert_eq!((scan.own_max, scan.in_max.len(), scan.last_ts_eff), (0, 0, 77));
        assert_eq!(read_log(&dir, &st.gid)[0], r);
        delete_log(&dir, &st.gid);
        assert!(read_log(&dir, &st.gid).is_empty());
        delete_log(&dir, &st.gid); // idempotent
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn group_log_append_tail_scan_and_ts_eff() {
        let dir = std::env::temp_dir().join(format!("velta-grouplog-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let gid = new_gid();
        let (me, other) = (key().public().to_string(), key().public().to_string());
        assert!(read_log(&dir, &gid).is_empty());
        assert_eq!(scan_log(&dir, &gid, &me), LogScan::default());

        let rec = |from: &str, seq: u64, dir_: &str, ts_eff: u64| GroupLogRec {
            seq, from: from.into(), id: format!("id{seq}{dir_}"), ts: ts_eff, ts_eff,
            dir: dir_.into(), text: format!("t{seq}"), reply_to: None, reply_text: None, file: None,
        };
        append_log(&dir, &gid, &rec(&me, 1, "out", 10)).unwrap();
        append_log(&dir, &gid, &rec(&other, 1, "in", 11)).unwrap();
        append_log(&dir, &gid, &rec(&me, 2, "out", 12)).unwrap();
        append_log(&dir, &gid, &rec(&other, 2, "in", 13)).unwrap();
        // A torn trailing line (crash mid-write) is skipped, not fatal.
        std::fs::OpenOptions::new().append(true).open(dir.join(format!("messages-g-{gid}.jsonl")))
            .unwrap().write_all(b"{\"seq\":3,\"fr").unwrap();
        assert_eq!(read_log(&dir, &gid).len(), 4);
        let tail = load_group_log(&dir, &gid, 3);
        assert_eq!(tail.iter().map(|r| (r.seq, r.dir.as_str())).collect::<Vec<_>>(), vec![(1, "in"), (2, "out"), (2, "in")]);
        let scan = scan_log(&dir, &gid, &me);
        assert_eq!(scan.own_max, 2);
        assert_eq!(scan.in_max[&other], 2);
        assert_eq!(scan.last_ts_eff, 13);

        // Display timestamps: monotonic, never in the future.
        assert_eq!(eff_ts(100, 90, 500), 100, "author clock behind: not before the previous message");
        assert_eq!(eff_ts(100, 700, 500), 500, "author clock ahead: capped at receive time");
        assert_eq!(eff_ts(100, 300, 500), 300);
        assert_eq!(eff_ts(600, 300, 500), 600, "an earlier clamp is never undone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
