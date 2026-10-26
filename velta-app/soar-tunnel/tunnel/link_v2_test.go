package tunnel

import (
	"encoding/base32"
	"encoding/base64"
	"reflect"
	"strings"
	"testing"
)

func TestParseLinkV2(t *testing.T) {
	raw := make([]byte, 32)
	for i := range raw {
		raw[i] = byte(i*7 + 250)
	}
	std := base64.StdEncoding.EncodeToString(raw)
	k32 := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(raw)
	link := "velta://tunnel/2/T.EXAMPLE.ORG/" + k32 + "/R/192.0.2.1*53+198.51.100.7+2001:DB8::1*853/C/CHECK.EXAMPLE.NET*443/N/J5TGM2LDMU"
	cfg, err := ParseLink(link)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Zone != "t.example.org" || cfg.Key != std {
		t.Fatalf("zone/key: %+v", cfg)
	}
	if want := []string{"192.0.2.1:53", "198.51.100.7:53", "[2001:db8::1]:853"}; !reflect.DeepEqual(cfg.Resolvers, want) {
		t.Fatalf("resolvers %v", cfg.Resolvers)
	}
	if !reflect.DeepEqual(cfg.Canaries, []string{"check.example.net:443"}) {
		t.Fatalf("canaries %v", cfg.Canaries)
	}
	// Same config as the v1 link; lowercase v2 works too.
	v1, err := ParseLink("velta://tunnel?v=1&zone=t.example.org&key=" + base64.RawURLEncoding.EncodeToString(raw) + "&r=192.0.2.1:53,198.51.100.7,%5B2001:db8::1%5D:853&c=check.example.net:443")
	if err != nil || !reflect.DeepEqual(v1, cfg) {
		t.Fatalf("v1 %+v %v", v1, err)
	}
	if low, err := ParseLink(strings.ToLower(link)); err != nil || !reflect.DeepEqual(low, cfg) {
		t.Fatalf("lowercase %+v %v", low, err)
	}
	if c, err := ParseLink("VELTA://TUNNEL/2/T.EXAMPLE.ORG/" + k32); err != nil || c.Canaries != nil || len(c.Resolvers) != 0 {
		t.Fatalf("minimal %+v %v", c, err)
	}
	if _, err := ParseLink("velta://tunnel/?v=1&zone=t.example.org&key=" + base64.RawURLEncoding.EncodeToString(raw)); err != nil {
		t.Fatalf("v1 with slash: %v", err)
	}
	ok := "velta://tunnel/2/T.EXAMPLE.ORG/" + k32
	for _, bad := range []string{
		"velta://tunnel/3/T.EXAMPLE.ORG/" + k32,
		"velta://tunnel/2/T.EXAMPLE.ORG/" + k32[:51],
		"velta://tunnel/2/T.EXAMPLE.ORG/" + k32[:51] + "B",
		"velta://tunnel/2/EXAMPLE/" + k32,
		ok + "/", ok + "/R", ok + "/R/", ok + "/X/1",
		ok + "/R/1.2.3.4/R/5.6.7.8", ok + "/R/DNS.EXAMPLE.ORG*53", ok + "/R/1.2.3.4*0", ok + "/R/1.2.3.4:53",
		ok + "/C/CHECK.EXAMPLE.NET",
	} {
		if _, err := ParseLink(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}
