package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/weblens-project/weblens-crawler/internal/analytics"
	"github.com/weblens-project/weblens-crawler/internal/contracts"
	"github.com/weblens-project/weblens-crawler/internal/model"
	"github.com/weblens-project/weblens-crawler/internal/postgres"
)

const maxCommandBody = 64 * 1024

var correlationIDPattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

type commandStore interface {
	AcceptCommand(context.Context, contracts.ScanCommandEnvelope) (bool, error)
	AcceptCancellation(context.Context, contracts.ScanCancelCommandEnvelope) (bool, error)
	Ping(context.Context) error
	GetReportState(context.Context, uuid.UUID, uuid.UUID) (model.ReportState, error)
}

type reportReader interface {
	ListPages(context.Context, uuid.UUID, uuid.UUID, int, string, uuid.UUID, model.PageFilters) ([]model.ReportPage, bool, error)
	ScanSummary(context.Context, uuid.UUID, uuid.UUID) (model.ScanReportSummary, error)
	GetPage(context.Context, uuid.UUID, uuid.UUID) (model.ReportPage, error)
}

type Server struct {
	store         commandStore
	reports       reportReader
	serviceDigest [32]byte
	logger        *slog.Logger
	mux           *http.ServeMux
}

func NewServer(store commandStore, reports reportReader, serviceToken string, logger *slog.Logger) *Server {
	server := &Server{store: store, reports: reports, serviceDigest: sha256.Sum256([]byte(serviceToken)), logger: logger, mux: http.NewServeMux()}
	server.mux.HandleFunc("GET /health/live", server.live)
	server.mux.HandleFunc("GET /health/ready", server.ready)
	server.mux.HandleFunc("POST /internal/v1/commands/scans", server.authenticate(server.acceptScan))
	server.mux.HandleFunc("GET /internal/v1/reports/scans/{scanId}/pages", server.authenticate(server.listPages))
	server.mux.HandleFunc("GET /internal/v1/reports/pages/{pageId}", server.authenticate(server.getPage))
	return server
}

func (s *Server) listPages(response http.ResponseWriter, request *http.Request) {
	ownerID, err := uuid.Parse(request.URL.Query().Get("ownerId"))
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_OWNER_ID", "ownerId must be a UUID.")
		return
	}
	scanID, err := uuid.Parse(request.PathValue("scanId"))
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_SCAN_ID", "scanId must be a UUID.")
		return
	}
	state, err := s.store.GetReportState(request.Context(), ownerID, scanID)
	if errors.Is(err, postgres.ErrReportNotFound) {
		writeProblem(response, request, http.StatusNotFound, "REPORT_NOT_FOUND", "The scan report does not exist.")
		return
	}
	if err != nil {
		s.logger.Error("read report state failed", "scanId", scanID, "error", err)
		writeProblem(response, request, http.StatusServiceUnavailable, "REPORT_UNAVAILABLE", "The scan report is temporarily unavailable.")
		return
	}
	limit, cursor, err := pageQuery(request)
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_PAGE_CURSOR", err.Error())
		return
	}
	filters, err := pageFiltersQuery(request)
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_PAGE_FILTER", err.Error())
		return
	}
	fingerprint := filterFingerprint(filters)
	if cursor.URL != "" && cursor.Filter != fingerprint {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_PAGE_CURSOR", "cursor does not match the active filters")
		return
	}
	pages, hasMore, err := s.reports.ListPages(request.Context(), ownerID, scanID, limit, cursor.URL, cursor.ID, filters)
	if err != nil {
		s.logger.Error("read page report failed", "scanId", scanID, "error", err)
		writeProblem(response, request, http.StatusServiceUnavailable, "REPORT_UNAVAILABLE", "The scan report is temporarily unavailable.")
		return
	}
	summary, err := s.reports.ScanSummary(request.Context(), ownerID, scanID)
	if err != nil {
		s.logger.Error("read scan report summary failed", "scanId", scanID, "error", err)
		writeProblem(response, request, http.StatusServiceUnavailable, "REPORT_UNAVAILABLE", "The scan report summary is temporarily unavailable.")
		return
	}
	nextCursor := ""
	if hasMore && len(pages) > 0 {
		last := pages[len(pages)-1]
		nextCursor = encodePageCursor(pageCursor{URL: last.URL, ID: last.ID, Filter: fingerprint})
	}
	writeJSON(response, http.StatusOK, model.ScanPagesReport{State: state, Summary: summary, Items: pages, NextCursor: nextCursor})
}

func issuesOnlyQuery(request *http.Request) (bool, error) {
	raw := strings.TrimSpace(request.URL.Query().Get("issuesOnly"))
	if raw == "" {
		return false, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return false, errors.New("issuesOnly must be true or false")
	}
	return value, nil
}

type pageCursor struct {
	URL    string    `json:"url"`
	ID     uuid.UUID `json:"id"`
	Filter string    `json:"filter,omitempty"`
}

func pageFiltersQuery(request *http.Request) (model.PageFilters, error) {
	issuesOnly, err := issuesOnlyQuery(request)
	if err != nil {
		return model.PageFilters{}, err
	}
	outcomes, err := enumValues(request.URL.Query()["outcome"], 3, map[string]bool{
		"SUCCESS": true, "WARNING": true, "FAILED": true,
	})
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("outcome: %w", err)
	}
	statusMin, err := optionalInt(request.URL.Query().Get("statusMin"), 0, 599)
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("statusMin: %w", err)
	}
	statusMax, err := optionalInt(request.URL.Query().Get("statusMax"), 0, 599)
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("statusMax: %w", err)
	}
	if statusMin != nil && statusMax != nil && *statusMin > *statusMax {
		return model.PageFilters{}, errors.New("statusMin must be less than or equal to statusMax")
	}
	query := strings.TrimSpace(request.URL.Query().Get("q"))
	if len(query) > 200 {
		return model.PageFilters{}, errors.New("q must contain at most 200 characters")
	}
	indexable, err := optionalBool(request.URL.Query().Get("indexable"))
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("indexable: %w", err)
	}
	contentTypes, err := boundedValues(request.URL.Query()["contentType"], 10, 128, false)
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("contentType: %w", err)
	}
	severities, err := enumValues(request.URL.Query()["severity"], 4, map[string]bool{
		"INFO": true, "WARNING": true, "ERROR": true, "CRITICAL": true,
	})
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("severity: %w", err)
	}
	findingCodes, err := boundedValues(request.URL.Query()["findingCode"], 20, 64, true)
	if err != nil {
		return model.PageFilters{}, fmt.Errorf("findingCode: %w", err)
	}
	return model.PageFilters{
		IssuesOnly: issuesOnly, Outcomes: outcomes, StatusMin: statusMin, StatusMax: statusMax,
		Query: query, Indexable: indexable, ContentTypes: contentTypes,
		Severities: severities, FindingCodes: findingCodes,
	}, nil
}

func optionalInt(raw string, minimum, maximum int) (*int, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return nil, fmt.Errorf("must be between %d and %d", minimum, maximum)
	}
	return &value, nil
}

func optionalBool(raw string) (*bool, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}
	value, err := strconv.ParseBool(raw)
	if err != nil {
		return nil, errors.New("must be true or false")
	}
	return &value, nil
}

func enumValues(values []string, maximum int, allowed map[string]bool) ([]string, error) {
	normalized, err := boundedValues(values, maximum, 64, true)
	if err != nil {
		return nil, err
	}
	for _, value := range normalized {
		if !allowed[value] {
			return nil, errors.New("contains an unsupported value")
		}
	}
	return normalized, nil
}

func boundedValues(values []string, maximum, maxLength int, uppercase bool) ([]string, error) {
	unique := make(map[string]struct{})
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if uppercase {
			value = strings.ToUpper(value)
		} else {
			value = strings.ToLower(value)
		}
		if value == "" || len(value) > maxLength {
			return nil, errors.New("contains an invalid value")
		}
		unique[value] = struct{}{}
	}
	if len(unique) > maximum {
		return nil, fmt.Errorf("accepts at most %d values", maximum)
	}
	result := make([]string, 0, len(unique))
	for value := range unique {
		result = append(result, value)
	}
	sort.Strings(result)
	return result, nil
}

func filterFingerprint(filters model.PageFilters) string {
	encoded, _ := json.Marshal(filters)
	digest := sha256.Sum256(encoded)
	return base64.RawURLEncoding.EncodeToString(digest[:])
}

func pageQuery(request *http.Request) (int, pageCursor, error) {
	limit := 100
	if raw := strings.TrimSpace(request.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 500 {
			return 0, pageCursor{}, errors.New("limit must be between 1 and 500")
		}
		limit = parsed
	}
	rawCursor := strings.TrimSpace(request.URL.Query().Get("cursor"))
	if rawCursor == "" {
		return limit, pageCursor{}, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(rawCursor)
	if err != nil {
		return 0, pageCursor{}, errors.New("cursor is invalid")
	}
	var cursor pageCursor
	if err := json.Unmarshal(decoded, &cursor); err != nil || cursor.URL == "" || cursor.ID == uuid.Nil {
		return 0, pageCursor{}, errors.New("cursor is invalid")
	}
	return limit, cursor, nil
}

func encodePageCursor(cursor pageCursor) string {
	encoded, _ := json.Marshal(cursor)
	return base64.RawURLEncoding.EncodeToString(encoded)
}

func (s *Server) getPage(response http.ResponseWriter, request *http.Request) {
	ownerID, err := uuid.Parse(request.URL.Query().Get("ownerId"))
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_OWNER_ID", "ownerId must be a UUID.")
		return
	}
	pageID, err := uuid.Parse(request.PathValue("pageId"))
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_PAGE_ID", "pageId must be a UUID.")
		return
	}
	page, err := s.reports.GetPage(request.Context(), ownerID, pageID)
	if errors.Is(err, analytics.ErrPageNotFound) {
		writeProblem(response, request, http.StatusNotFound, "PAGE_NOT_FOUND", "The page report does not exist.")
		return
	}
	if err != nil {
		s.logger.Error("read page detail failed", "pageId", pageID, "error", err)
		writeProblem(response, request, http.StatusServiceUnavailable, "REPORT_UNAVAILABLE", "The page report is temporarily unavailable.")
		return
	}
	writeJSON(response, http.StatusOK, page)
}

func (s *Server) Handler() http.Handler {
	return http.MaxBytesHandler(s.withSecurityHeaders(s.mux), maxCommandBody)
}

func (s *Server) live(response http.ResponseWriter, _ *http.Request) {
	writeJSON(response, http.StatusOK, map[string]string{"status": "UP"})
}

func (s *Server) ready(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), 2*time.Second)
	defer cancel()
	if err := s.store.Ping(ctx); err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]string{"status": "DOWN"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]string{"status": "UP"})
}

func (s *Server) acceptScan(response http.ResponseWriter, request *http.Request) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxCommandBody+1))
	var maximumBytesError *http.MaxBytesError
	if errors.As(err, &maximumBytesError) || len(body) > maxCommandBody {
		writeProblem(response, request, http.StatusRequestEntityTooLarge, "COMMAND_TOO_LARGE", "The command body is limited to 64 KiB.")
		return
	}
	if err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_COMMAND", "The command body is invalid.")
		return
	}
	var header struct {
		MessageType string `json:"messageType"`
	}
	if err := json.Unmarshal(body, &header); err != nil {
		writeProblem(response, request, http.StatusBadRequest, "INVALID_COMMAND", "The command body is invalid.")
		return
	}

	var duplicate bool
	var messageID any
	var aggregateID any
	switch header.MessageType {
	case contracts.ScanRequestedV1:
		var envelope contracts.ScanCommandEnvelope
		if err := decodeStrict(body, &envelope); err != nil {
			writeProblem(response, request, http.StatusBadRequest, "INVALID_COMMAND", "The command body is invalid.")
			return
		}
		messageID, aggregateID = envelope.MessageID, envelope.AggregateID
		duplicate, err = s.store.AcceptCommand(request.Context(), envelope)
	case contracts.ScanCancelV1:
		var envelope contracts.ScanCancelCommandEnvelope
		if err := decodeStrict(body, &envelope); err != nil {
			writeProblem(response, request, http.StatusBadRequest, "INVALID_COMMAND", "The command body is invalid.")
			return
		}
		messageID, aggregateID = envelope.MessageID, envelope.AggregateID
		duplicate, err = s.store.AcceptCancellation(request.Context(), envelope)
	default:
		writeProblem(response, request, http.StatusUnprocessableEntity, "COMMAND_REJECTED", "The command type is not supported.")
		return
	}
	if err != nil {
		switch {
		case errors.Is(err, postgres.ErrMessageCollision):
			writeProblem(response, request, http.StatusConflict, "MESSAGE_ID_COLLISION", "The message ID was already used with different content.")
		case errors.Is(err, postgres.ErrExecutionNotReady):
			writeProblem(response, request, http.StatusConflict, "EXECUTION_NOT_READY", "The crawl execution is not ready for this command.")
		default:
			s.logger.Error("scan command rejected", "messageId", messageID, "error", err)
			writeProblem(response, request, http.StatusUnprocessableEntity, "COMMAND_REJECTED", "The scan command was rejected.")
		}
		return
	}
	status := http.StatusAccepted
	if duplicate {
		status = http.StatusOK
	}
	writeJSON(response, status, map[string]any{"accepted": true, "duplicate": duplicate, "scanId": aggregateID})
}

func (s *Server) authenticate(next http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		supplied := strings.TrimSpace(request.Header.Get("X-WebLens-Service-Token"))
		digest := sha256.Sum256([]byte(supplied))
		if supplied == "" || subtle.ConstantTimeCompare(digest[:], s.serviceDigest[:]) != 1 {
			writeProblem(response, request, http.StatusUnauthorized, "SERVICE_AUTHENTICATION_REQUIRED", "Valid service authentication is required.")
			return
		}
		next(response, request)
	}
}

func (s *Server) withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.Header().Set("Cache-Control", "no-store")
		correlationID := strings.TrimSpace(request.Header.Get("X-Correlation-ID"))
		if !correlationIDPattern.MatchString(correlationID) {
			correlationID = uuid.NewString()
		}
		response.Header().Set("X-Correlation-ID", correlationID)
		next.ServeHTTP(response, request)
	})
}

func ensureEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func decodeStrict(body []byte, target any) error {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	return ensureEOF(decoder)
}

func writeProblem(response http.ResponseWriter, request *http.Request, status int, code, detail string) {
	response.Header().Set("Content-Type", "application/problem+json")
	writeJSON(response, status, map[string]any{
		"type":  "https://docs.weblens.dev/problems/" + strings.ToLower(strings.ReplaceAll(code, "_", "-")),
		"title": http.StatusText(status), "status": status, "detail": detail,
		"instance": request.URL.Path, "code": code,
		"correlationId": response.Header().Get("X-Correlation-ID"),
	})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	if response.Header().Get("Content-Type") == "" {
		response.Header().Set("Content-Type", "application/json")
	}
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
