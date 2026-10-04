package crawl

import (
	"context"
	"errors"
	"net/netip"
	"testing"
)

type staticResolver struct {
	addresses []netip.Addr
}

func (r staticResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return r.addresses, nil
}

func TestPublicAddressPolicy(t *testing.T) {
	t.Parallel()
	cases := []struct {
		address string
		public  bool
	}{
		{"8.8.8.8", true},
		{"2606:4700:4700::1111", true},
		{"127.0.0.1", false},
		{"10.0.0.1", false},
		{"172.16.0.1", false},
		{"192.168.0.1", false},
		{"169.254.169.254", false},
		{"::ffff:127.0.0.1", false},
		{"fd00::1", false},
		{"fe80::1", false},
		{"100.64.0.1", false},
		{"192.0.2.10", false},
		{"198.18.0.1", false},
		{"2001:db8::1", false},
		{"::1", false},
	}
	for _, testCase := range cases {
		address := netip.MustParseAddr(testCase.address)
		if actual := isPublicAddress(address); actual != testCase.public {
			t.Errorf("isPublicAddress(%s) = %v, want %v", address, actual, testCase.public)
		}
	}
}

func TestLocalAddressPolicyOnlyAllowsLoopbackAndPrivateRanges(t *testing.T) {
	t.Parallel()
	cases := []struct {
		address string
		local   bool
	}{
		{"127.0.0.1", true},
		{"10.0.0.1", true},
		{"172.16.0.1", true},
		{"192.168.0.1", true},
		{"::1", true},
		{"fd00::1", true},
		{"8.8.8.8", false},
		{"169.254.169.254", false},
		{"100.64.0.1", false},
		{"0.0.0.0", false},
	}
	for _, testCase := range cases {
		address := netip.MustParseAddr(testCase.address)
		if actual := isLocalAddress(address); actual != testCase.local {
			t.Errorf("isLocalAddress(%s) = %v, want %v", address, actual, testCase.local)
		}
	}
}

func TestLocalOnlyDialerRejectsPublicOrMixedDNSAnswersBeforeDial(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name      string
		addresses []netip.Addr
	}{
		{"public", []netip.Addr{netip.MustParseAddr("8.8.8.8")}},
		{"mixed", []netip.Addr{netip.MustParseAddr("127.0.0.1"), netip.MustParseAddr("8.8.8.8")}},
		{"metadata", []netip.Addr{netip.MustParseAddr("169.254.169.254")}},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			dialer := newSafeDialerWithResolver(staticResolver{addresses: testCase.addresses}, true)
			connection, err := dialer.DialContext(context.Background(), "tcp", "fixture.test:80")
			if connection != nil {
				_ = connection.Close()
				t.Fatal("disallowed destination returned a connection")
			}
			if !errors.Is(err, ErrUnsafeAddress) {
				t.Fatalf("expected ErrUnsafeAddress, got %v", err)
			}
		})
	}
}

func TestPublicDialerRejectsMixedDNSBeforeConnecting(t *testing.T) {
	addresses := []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}
	dialer := newSafeDialerWithResolver(staticResolver{addresses: addresses}, false)
	connection, err := dialer.DialContext(context.Background(), "tcp", "fixture.test:80")
	if connection != nil {
		_ = connection.Close()
		t.Fatal("mixed public/private DNS returned a connection")
	}
	if !errors.Is(err, ErrUnsafeAddress) {
		t.Fatalf("expected ErrUnsafeAddress, got %v", err)
	}
}
