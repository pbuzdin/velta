package tunnel

import (
	"encoding/base32"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strings"
)

// Link v2 keeps everything after velta://tunnel/ in the QR alphanumeric set
// (0-9 A-Z space $%*+-./:), so a QR code of it stays small:
//
//	velta://tunnel/2/<ZONE>/<KEY base32>[/R/<ip[*port]>+…][/C/<HOST*port>+…][/N/<label base32>]
//
// The key is RFC 4648 base32 without padding (52 chars), either case.
// Resolvers: an IPv4 or IPv6 literal (no brackets), "*port" optional.
// N is the label, ignored here like v1's n.
const linkV2Prefix = "velta://tunnel/"

var b32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// parseLinkV2 reports ok=false when link is not in the path form
// (velta://tunnel/<digit>…); v1 links, also velta://tunnel/?v=1&…, fall through.
func parseLinkV2(link string) (Config, bool, error) {
	n := len(linkV2Prefix)
	if len(link) <= n || !strings.EqualFold(link[:n], linkV2Prefix) || link[n] < '0' || link[n] > '9' {
		return Config{}, false, nil
	}
	parts := strings.Split(link[len(linkV2Prefix):], "/")
	if parts[0] != "2" {
		return Config{}, true, fmt.Errorf("unsupported link version %q", parts[0])
	}
	if len(parts) < 3 || len(parts)%2 == 0 {
		return Config{}, true, errors.New("bad v2 link")
	}
	k := strings.ToUpper(parts[2])
	key, err := b32.DecodeString(k)
	if err != nil || len(key) != 32 || b32.EncodeToString(key) != k { // canonical: zero trailing bits
		return Config{}, true, errors.New("bad server key")
	}
	cfg := Config{Zone: parts[1], Key: base64.StdEncoding.EncodeToString(key)}
	seen := map[string]bool{}
	for i := 3; i < len(parts); i += 2 {
		k, v := strings.ToUpper(parts[i]), parts[i+1]
		if seen[k] || v == "" {
			return Config{}, true, fmt.Errorf("bad parameter %q", k)
		}
		seen[k] = true
		switch k {
		case "R":
			for _, r := range strings.Split(v, "+") {
				ip, port, hasPort := strings.Cut(r, "*")
				if net.ParseIP(ip) == nil {
					return Config{}, true, fmt.Errorf("bad resolver %q", r)
				}
				if hasPort {
					r = net.JoinHostPort(ip, port)
				}
				cfg.Resolvers = append(cfg.Resolvers, r)
			}
		case "C":
			for _, c := range strings.Split(v, "+") {
				host, port, ok := strings.Cut(c, "*")
				if !ok || host == "" {
					return Config{}, true, fmt.Errorf("bad canary %q", c)
				}
				cfg.Canaries = append(cfg.Canaries, net.JoinHostPort(strings.ToLower(host), port))
			}
		case "N":
		default:
			return Config{}, true, fmt.Errorf("unknown parameter %q", k)
		}
	}
	out, err := cfg.Normalize()
	if err != nil {
		return Config{}, true, err
	}
	if len(cfg.Canaries) == 0 {
		out.Canaries = nil
	}
	return out, true, nil
}
