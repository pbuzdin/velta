package tunnel

import (
	"encoding/base64"
	"net"
	"testing"
	"time"
)

// Dead saved tunnel (#176 follow-up): Start, a CONNECT through the dead
// tunnel, and Close must stay bounded so the shell never stalls on them.
func TestDeadTunnelTimings(t *testing.T) {
	if testing.Short() {
		t.Skip("timing test")
	}
	key := base64.StdEncoding.EncodeToString(make([]byte, 32))
	t0 := time.Now()
	tun, err := Start(Config{Zone: "t.example.invalid", Key: key, Resolvers: []string{"192.0.2.1:53"}, Mode: ModeAlways, Listen: "127.0.0.1:0"})
	if err != nil {
		t.Fatal(err)
	}
	if d := time.Since(t0); d > 3*time.Second {
		t.Errorf("Start took %v (> 3 s)", d)
	} else {
		t.Logf("Start took %v", d)
	}
	c, err := net.Dial("tcp", tun.Addr())
	if err != nil {
		t.Fatal(err)
	}
	c.Write([]byte{5, 1, 0})
	buf := make([]byte, 64)
	c.Read(buf)
	c.Write([]byte{5, 1, 0, 3, 11, 'e', 'x', 'a', 'm', 'p', 'l', 'e', '.', 'o', 'r', 'g', 0, 143})
	closed := make(chan time.Duration, 1)
	go func() { time.Sleep(5 * time.Second); t1 := time.Now(); tun.Close(); closed <- time.Since(t1) }()
	t2 := time.Now()
	c.SetReadDeadline(time.Now().Add(90 * time.Second))
	n, err := c.Read(buf)
	t.Logf("CONNECT answered after %v: % x err=%v", time.Since(t2), buf[:n], err)
	if d := <-closed; d > time.Second {
		t.Errorf("Close with a CONNECT pending took %v (> 1 s)", d)
	}
}
