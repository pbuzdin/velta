// Package tunnel is Velta's optional DNS-tunnel transport: a local SOCKS5
// proxy for the Delta Chat core that connects directly while the network is
// normal and through a soar DNS tunnel (github.com/getlantern/soar) when the
// relays are only reachable over DNS (allowlist-only mobile internet).
//
// Nothing here names a server. The zone and key arrive in a velta://tunnel
// link at runtime; without one the app never starts the tunnel.
package tunnel

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
)

// Modes. Auto routes directly and switches to the tunnel when the relays are
// blocked; Always forces the tunnel; Off never uses it.
const (
	ModeAuto   = "auto"
	ModeAlways = "always"
	ModeOff    = "off"
)

// DefaultResolvers are public recursive resolvers used when a link carries
// none. soar uses all of them at once and backs off the ones that don't
// answer (an IPv6 path on an IPv4-only phone costs a failed send, nothing
// more). Ports 853 are DNS-over-TLS paths.
//
// Selection (2026-10): each one carried a query for the tunnel zone to the
// server from residential networks in the target region (Globalping
// eyeball probes).
// Left out: Cloudflare (SERVFAIL from most probes), SkyDNS (filters the
// zone), Comss/Xbox DNS (smart-DNS proxies, SERVFAIL), MSK-IX IPv6
// (SERVFAIL), and operator resolvers, which only answer their own
// subscribers (a link can add them with r=).
var DefaultResolvers = []string{
	// NSDI: fastest paths measured, reported working in allowlist mode.
	"195.208.4.1:53", "195.208.5.1:53", "[2a0c:a9c7:8::1]:53",
	// MSK-IX.
	"62.76.62.76:53", "62.76.76.62:53",
	// Yandex basic, Safe and Family profiles: reachable on allowlist-only
	// mobile networks.
	"77.88.8.8:53", "77.88.8.1:53", "[2a02:6b8::feed:0ff]:53", "[2a02:6b8:0:1::feed:0ff]:53",
	"77.88.8.88:53", "77.88.8.2:53", "[2a02:6b8::feed:bad]:53", "[2a02:6b8:0:1::feed:bad]:53",
	"77.88.8.7:53", "77.88.8.3:53", "[2a02:6b8::feed:a11]:53", "[2a02:6b8:0:1::feed:a11]:53",
	"77.88.8.8:853", "77.88.8.1:853", "77.88.8.88:853", "77.88.8.7:853",
	// TransTeleCom "Public Servers": open, answered all 28 regional probes.
	"217.150.34.129:53",
	// SafeDNS, Google, Quad9.
	"195.46.39.39:53", "195.46.39.40:53",
	"8.8.8.8:53", "8.8.4.4:53",
	"9.9.9.9:53",
}

// DefaultCanaries are hosts that stay reachable on allowlist-only networks.
// Any of them answering while every relay fails means "blocked", not "offline".
var DefaultCanaries = []string{"ya.ru:443", "max.ru:443", "gosuslugi.ru:443"}

const maxResolvers = 64

// Config is the tunnel configuration. Zone, Key and Resolvers come from the
// link; the rest is local state the app keeps next to it.
type Config struct {
	Zone      string   `json:"zone"`
	Key       string   `json:"key"` // server Ed25519 public key, standard base64
	Resolvers []string `json:"resolvers"`
	Canaries  []string `json:"canaries,omitempty"`
	// SystemResolvers are the DNS servers the phone's current network handed
	// out (the operator's on mobile data); Operator is the SIM's MCC+MNC.
	// Both come from the app at start, never from a link.
	SystemResolvers []string `json:"system_resolvers,omitempty"`
	Operator        string   `json:"operator,omitempty"`
	Mode            string   `json:"mode,omitempty"`
	Listen          string   `json:"listen,omitempty"` // default 127.0.0.1:0
	User            string   `json:"user,omitempty"`   // SOCKS5 credentials; empty = no auth
	Pass            string   `json:"pass,omitempty"`
}

// ParseLink parses velta://tunnel?v=1&zone=<zone>&key=<base64>[&r=<ip:port,…>][&c=<host:port,…>]
// and the v2 path form (link_v2.go).
// r adds resolvers to the defaults; c replaces the default canaries.
// The key may be standard or URL-safe base64, padded or not.
func ParseLink(link string) (Config, error) {
	if cfg, ok, err := parseLinkV2(strings.TrimSpace(link)); ok {
		return cfg, err
	}
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil {
		return Config{}, fmt.Errorf("bad link: %w", err)
	}
	if !strings.EqualFold(u.Scheme, "velta") || !strings.EqualFold(u.Host, "tunnel") {
		return Config{}, errors.New("not a velta://tunnel link")
	}
	q := u.Query()
	if v := q.Get("v"); v != "" && v != "1" {
		return Config{}, fmt.Errorf("unsupported link version %q", v)
	}
	cfg := Config{Zone: q.Get("zone"), Key: q.Get("key")}
	if r := q.Get("r"); r != "" {
		cfg.Resolvers = strings.Split(r, ",")
	}
	if c := q.Get("c"); c != "" {
		cfg.Canaries = strings.Split(c, ",")
	}
	n, err := cfg.Normalize()
	if err != nil {
		return Config{}, err
	}
	// Keep only what the link set: default canaries are filled at start, so
	// an app update with better ones reaches tunnels installed earlier.
	if len(cfg.Canaries) == 0 {
		n.Canaries = nil
	}
	return n, nil
}

// Normalize validates the config and fills defaults.
func (c Config) Normalize() (Config, error) {
	c.Zone = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(c.Zone)), ".")
	if err := checkZone(c.Zone); err != nil {
		return Config{}, err
	}
	key, err := decodeKey(c.Key)
	if err != nil {
		return Config{}, err
	}
	c.Key = base64.StdEncoding.EncodeToString(key)

	var rs []string
	seen := map[string]bool{}
	for _, r := range c.Resolvers {
		r = strings.TrimSpace(r)
		if r == "" {
			continue
		}
		norm, err := checkResolver(r)
		if err != nil {
			return Config{}, err
		}
		if !seen[norm] {
			seen[norm] = true
			rs = append(rs, norm)
		}
	}
	if len(rs) > maxResolvers {
		return Config{}, fmt.Errorf("too many resolvers (%d, max %d)", len(rs), maxResolvers)
	}
	// Link resolvers add to DefaultResolvers (see Effective), so better
	// defaults in an app update reach every installed tunnel.
	c.Resolvers = rs

	// The network's own resolvers first: on allowlist-only mobile internet
	// the operator-assigned one is the resolver that keeps answering. Bad
	// entries from the device are dropped, not fatal.
	var sys []string
	for _, r := range c.SystemResolvers {
		if norm, err := checkResolver(strings.TrimSpace(r)); err == nil {
			sys = append(sys, norm)
		}
	}
	c.SystemResolvers = sys

	var cs []string
	for _, h := range c.Canaries {
		h = strings.TrimSpace(h)
		if h == "" {
			continue
		}
		if _, _, err := net.SplitHostPort(h); err != nil {
			h = net.JoinHostPort(h, "443") // bare host
		}
		cs = append(cs, h)
	}
	if len(cs) > 8 {
		return Config{}, fmt.Errorf("too many canaries (%d, max 8)", len(cs))
	}
	if len(cs) == 0 {
		cs = append([]string(nil), DefaultCanaries...)
	}
	c.Canaries = cs
	switch c.Mode {
	case "":
		c.Mode = ModeAuto
	case ModeAuto, ModeAlways, ModeOff:
	default:
		return Config{}, fmt.Errorf("unknown mode %q", c.Mode)
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:0"
	}
	return c, nil
}

// Effective is the resolver list the tunnel uses: the network's resolvers,
// then the SIM operator's known resolvers, then the link's extra resolvers,
// then DefaultResolvers, without duplicates and capped at maxResolvers.
func (c Config) Effective() []string {
	seen := map[string]bool{}
	var out []string
	add := func(list []string) {
		for _, r := range list {
			if !seen[r] && len(out) < maxResolvers {
				seen[r] = true
				out = append(out, r)
			}
		}
	}
	add(c.SystemResolvers)
	add(OperatorResolvers[c.Operator])
	add(c.Resolvers)
	add(DefaultResolvers)
	return out
}

func checkZone(z string) error {
	if len(z) == 0 || len(z) > 200 {
		return errors.New("bad zone")
	}
	labels := strings.Split(z, ".")
	if len(labels) < 2 {
		return errors.New("zone needs at least two labels")
	}
	for _, l := range labels {
		if len(l) == 0 || len(l) > 63 || l[0] == '-' || l[len(l)-1] == '-' {
			return fmt.Errorf("bad zone label %q", l)
		}
		for _, ch := range l {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-') {
				return fmt.Errorf("bad zone label %q", l)
			}
		}
	}
	return nil
}

func decodeKey(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding, base64.URLEncoding, base64.RawURLEncoding} {
		if b, err := enc.DecodeString(s); err == nil {
			if len(b) != 32 {
				return nil, fmt.Errorf("key must be 32 bytes, got %d", len(b))
			}
			return b, nil
		}
	}
	return nil, errors.New("key is not base64")
}

// checkResolver accepts only IP literals: an app on Android may have no usable
// system resolver for a hostname, and a resolver named by DNS defeats the point.
func checkResolver(r string) (string, error) {
	host, port, err := net.SplitHostPort(r)
	if err != nil {
		// Bare IP: default to port 53.
		if ip := net.ParseIP(strings.Trim(r, "[]")); ip != nil {
			return net.JoinHostPort(ip.String(), "53"), nil
		}
		return "", fmt.Errorf("bad resolver %q", r)
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", fmt.Errorf("resolver %q must be an IP address", r)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return "", fmt.Errorf("bad resolver port in %q", r)
	}
	return net.JoinHostPort(ip.String(), port), nil
}
