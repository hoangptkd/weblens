package postgres

import "testing"

func TestMigrationChecksumIgnoresWindowsLineEndings(t *testing.T) {
	lf := []byte("CREATE TABLE example (id bigint);\n")
	crlf := []byte("CREATE TABLE example (id bigint);\r\n")

	if migrationChecksum(lf) != migrationChecksum(crlf) {
		t.Fatal("migration checksum must be stable across LF and CRLF checkouts")
	}
}
