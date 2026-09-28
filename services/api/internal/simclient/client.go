// Package simclient gọi HTTP API của sim-service.
package simclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/kaizenflow/api/internal/simapi"
)

type Client struct {
	BaseURL string
	HTTP    *http.Client
}

func New(base string) *Client {
	return &Client{BaseURL: strings.TrimRight(base, "/"), HTTP: &http.Client{Timeout: 120 * time.Second}}
}

func (c *Client) do(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rd io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, rd)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return c.HTTP.Do(req)
}

func contractError(body []byte) error {
	var obj struct {
		Detail json.RawMessage `json:"detail"`
	}
	if json.Unmarshal(body, &obj) == nil {
		var ce simapi.ContractError
		if json.Unmarshal(obj.Detail, &ce) == nil && ce.Key != "" {
			return &ce
		}
	}
	return &simapi.ContractError{Key: "request", Message: string(body)}
}

func (c *Client) expect(resp *http.Response, want int) ([]byte, error) {
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnprocessableEntity {
		return nil, contractError(b)
	}
	if resp.StatusCode != want {
		return nil, fmt.Errorf("sim-service %s: %d %s", resp.Request.URL.Path, resp.StatusCode, string(b))
	}
	return b, nil
}

func (c *Client) Validate(ctx context.Context, req *simapi.RunRequest) error {
	resp, err := c.do(ctx, http.MethodPost, "/validate", req)
	if err != nil {
		return err
	}
	_, err = c.expect(resp, http.StatusOK)
	return err
}

func (c *Client) StartRun(ctx context.Context, req *simapi.RunRequest) error {
	resp, err := c.do(ctx, http.MethodPost, "/runs", req)
	if err != nil {
		return err
	}
	_, err = c.expect(resp, http.StatusAccepted)
	return err
}

func (c *Client) Status(ctx context.Context, id int64) (*simapi.Status, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/runs/%d", id), nil)
	if err != nil {
		return nil, err
	}
	b, err := c.expect(resp, http.StatusOK)
	if err != nil {
		return nil, err
	}
	var st simapi.Status
	return &st, json.Unmarshal(b, &st)
}

func (c *Client) Result(ctx context.Context, id int64) (*simapi.Result, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/runs/%d/result", id), nil)
	if err != nil {
		return nil, err
	}
	b, err := c.expect(resp, http.StatusOK)
	if err != nil {
		return nil, err
	}
	var res simapi.Result
	return &res, json.Unmarshal(b, &res)
}

func (c *Client) ExportCSV(ctx context.Context, id int64) (io.ReadCloser, error) {
	resp, err := c.do(ctx, http.MethodGet, fmt.Sprintf("/runs/%d/export.csv", id), nil)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("sim-service export: %d %s", resp.StatusCode, string(b))
	}
	return resp.Body, nil
}
