package main

import "testing"

func TestParseDotEnv(t *testing.T) {
	data := []byte("" +
		"# a comment\n" +
		"\n" +
		"RUNPOD_ENDPOINT_ID=abc123\n" +
		"export RUNPOD_API_KEY=secret-key\n" +
		"  WS_STEPS = 30 \n" +
		"QUOTED=\"hello world\"\n" +
		"SINGLE='moss green'\n" +
		"# WORLDSKETCH_PUBLIC_URL=https://example.com\n" +
		"EMPTY=\n" +
		"NOEQUALS\n",
	)
	got := parseDotEnv(data)

	want := map[string]string{
		"RUNPOD_ENDPOINT_ID": "abc123",
		"RUNPOD_API_KEY":     "secret-key",
		"WS_STEPS":           "30",
		"QUOTED":             "hello world",
		"SINGLE":             "moss green",
		"EMPTY":              "",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("parseDotEnv[%q] = %q, want %q", k, got[k], v)
		}
	}
	// Commented and malformed lines must not produce keys.
	if _, ok := got["WORLDSKETCH_PUBLIC_URL"]; ok {
		t.Error("commented-out line should not be parsed")
	}
	if _, ok := got["NOEQUALS"]; ok {
		t.Error("line without '=' should be skipped")
	}
	if len(got) != len(want) {
		t.Errorf("got %d keys, want %d: %v", len(got), len(want), got)
	}
}
