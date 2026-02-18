# WebSocket Job Status Updates — Frontend Integration Guide

## Overview

The backend provides real-time job status updates via WebSocket. When a document is uploaded for processing, the client can subscribe to a `jobId` and receive live phase-by-phase progress updates instead of polling.

## Connection Details

- **REST API base:** `http://ai.safentro.com/api`
- **WebSocket endpoint:** `ws://ai.safentro.com/api/ws`

## Protocol

### 1. Connect

Open a WebSocket connection to `ws://ai.safentro.com/api/ws`.

### 2. Subscribe to a Job

After uploading a document via the REST API, you receive a `jobId` in the response. Send a subscribe message:

```json
{ "type": "subscribe", "jobId": "<job-id-from-upload-response>" }
```

The server responds with a confirmation:

```json
{ "type": "subscribed", "jobId": "...", "timestamp": "..." }
```

You can subscribe to multiple jobs on the same connection by sending multiple subscribe messages.

### 3. Receive Status Updates

The server pushes messages as the job progresses:

```json
{
  "type": "status_update",
  "jobId": "abc-123",
  "status": "processing",
  "phase": "ocr_started",
  "message": "Starting text extraction for 3 document(s)",
  "timestamp": "2026-02-18T10:30:00.000Z"
}
```

### 4. Unsubscribe (optional)

```json
{ "type": "unsubscribe", "jobId": "<job-id>" }
```

## Phase Progression

Updates arrive in this order for a successful job:

| Phase            | Status       | Meaning                              |
|------------------|--------------|--------------------------------------|
| `processing`     | `processing` | Job claimed by worker                |
| `ocr_started`    | `processing` | Text extraction (OCR) has started    |
| `ocr_completed`  | `processing` | Text extraction finished             |
| `ai_started`     | `processing` | AI coding analysis has started       |
| `ai_completed`   | `processing` | AI analysis finished                 |
| `saving_results` | `processing` | Writing results to database          |
| `completed`      | `completed`  | Job done — results are available     |

If the job fails:

| Phase    | Status   | Meaning                                          |
|----------|----------|--------------------------------------------------|
| `failed` | `failed` | Job failed. `message` includes retry info if any |

## Example: React Hook

```javascript
import { useEffect, useRef, useState, useCallback } from 'react';

const WS_URL = 'ws://ai.safentro.com/api/ws';

export function useJobStatus(jobId) {
  const [status, setStatus] = useState(null);
  const [phase, setPhase] = useState(null);
  const [message, setMessage] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef(null);

  useEffect(() => {
    if (!jobId) return;

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setIsConnected(true);
      ws.send(JSON.stringify({ type: 'subscribe', jobId }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'status_update') {
        setStatus(data.status);
        setPhase(data.phase);
        setMessage(data.message);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
    };

    ws.onerror = () => {
      setIsConnected(false);
    };

    return () => {
      ws.close();
    };
  }, [jobId]);

  return { status, phase, message, isConnected };
}
```

### Usage in a component

```jsx
function DocumentProcessingStatus({ jobId }) {
  const { status, phase, message, isConnected } = useJobStatus(jobId);

  if (!jobId) return null;

  return (
    <div>
      <p>Status: {status ?? 'waiting...'}</p>
      <p>Phase: {phase ?? '—'}</p>
      <p>{message}</p>
      {status === 'completed' && <p>Done! Fetch results now.</p>}
      {status === 'failed' && <p>Failed: {message}</p>}
    </div>
  );
}
```

## Reconnection Strategy

The WebSocket connection can drop. Implement reconnection with backoff:

```javascript
function connectWithRetry(jobId, onUpdate, maxRetries = 5) {
  let attempt = 0;

  function connect() {
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      attempt = 0; // reset on success
      ws.send(JSON.stringify({ type: 'subscribe', jobId }));
    };

    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === 'status_update') {
        onUpdate(data);
      }
    };

    ws.onclose = () => {
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * 2 ** attempt, 10000);
        attempt++;
        setTimeout(connect, delay);
      }
    };

    return ws;
  }

  return connect();
}
```

## Typical Frontend Flow

1. User uploads documents via `POST http://ai.safentro.com/api/documents/upload`
2. Response includes a `jobId`
3. Open WebSocket to `ws://ai.safentro.com/api/ws`
4. Send `{ "type": "subscribe", "jobId": "<jobId>" }`
5. Render a progress indicator that updates on each `status_update` message
6. When `status === 'completed'`, fetch final results via `GET http://ai.safentro.com/api/documents/status/<chartNumber>`
7. Close the WebSocket connection (or keep it open for future jobs)

## Error Messages

| Message Type | Meaning |
|---|---|
| `{ "type": "subscribed", "jobId": "..." }` | Subscription confirmed |
| `{ "type": "unsubscribed", "jobId": "..." }` | Unsubscription confirmed |
| `{ "type": "error", "message": "..." }` | Invalid message sent by client |
| `{ "type": "status_update", ... }` | Job progress update |

## Notes

- One WebSocket connection can subscribe to multiple jobs simultaneously.
- The server sends pings every 30 seconds; the browser handles pong responses automatically.
- If the WebSocket disconnects mid-job, reconnect and re-subscribe — you won't miss the final state since you can always fall back to the REST polling endpoint.
