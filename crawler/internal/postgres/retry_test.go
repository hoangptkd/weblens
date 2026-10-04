package postgres

import (
	"testing"
	"time"

	"github.com/weblens-project/weblens-crawler/internal/model"
)

func TestPageRetryPolicyIsBoundedAndOnlyRetriesTransientFailures(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		result  model.PageResult
		attempt int
		retry   bool
	}{
		{"timeout", model.PageResult{ErrorCode: "timeout"}, 1, true},
		{"rate limited", model.PageResult{StatusCode: 429}, 2, true},
		{"server error", model.PageResult{StatusCode: 503}, 1, true},
		{"not implemented", model.PageResult{StatusCode: 501}, 1, false},
		{"unsupported HTTP version", model.PageResult{StatusCode: 505}, 1, false},
		{"unsafe address", model.PageResult{ErrorCode: "ssrf_blocked"}, 1, false},
		{"client error", model.PageResult{StatusCode: 404}, 1, false},
		{"attempt budget exhausted", model.PageResult{ErrorCode: "timeout"}, 3, false},
	}
	for _, testCase := range cases {
		if actual := shouldRetryPage(testCase.result, testCase.attempt); actual != testCase.retry {
			t.Errorf("%s: shouldRetryPage() = %v, want %v", testCase.name, actual, testCase.retry)
		}
	}
	var key [16]byte
	key[0] = 255
	if delay := pageRetryDelay(2, key); delay != 4*time.Second {
		t.Fatalf("unexpected maximum second retry delay: %s", delay)
	}
}
