// Reading the progress a RunPod worker emits while it runs.
//
// These pods yield text chunks as the ComfyUI graph executes, each prefixed with
// the node id that produced it ("32 sampling ..."). RunPod exposes them at
// /stream/<jobId>, which is drain-on-read: a call returns only what has arrived
// since the last one, and a job that has already finished returns nothing. That
// is the whole reason this has to be polled alongside the status call rather
// than read once at the end.
//
// Ported from momi-forge's utils.py (_extract_stream_progress_signals and
// friends), which is the working implementation of the same idea.

/** A node id prefix: "32", or "80:29" for a nested subgraph node. */
const NODE_ID_PREFIX = /^(\d+(?::\d+)?)\b/;

// Chunks can be re-delivered, so each is remembered by signature. Bounded
// because a long render emits thousands and this set would otherwise grow for
// the life of the job.
const MAX_REMEMBERED_CHUNKS = 512;

export type StreamProgressReader = {
  /** New chunks since the last read, oldest first. */
  read: (payload: unknown) => StreamProgressChunk[];
  /**
   * Records something worth knowing about this job's stream, at most once per
   * distinct message.
   *
   * The stream is read with every failure swallowed, so that a progress problem
   * cannot take down a paid render. The cost of that is that "the worker reports
   * nothing" and "our request is failing" look identical from outside. These
   * notes are the difference, and they are deliberately not behind a debug flag:
   * one or two lines per job is cheap, and the question comes up every time a
   * preset appears to report no detail.
   */
  note: (message: string) => void;
  /**
   * Reports what the stream did overall. Call once when polling stops, whatever
   * the outcome -- a job that never streamed should say so however briefly it
   * ran.
   */
  summarize: () => void;
};

export type StreamProgressChunk = {
  text: string;
  /** The ComfyUI node that produced it, when the text names one. */
  nodeId?: string;
};

export function createStreamProgressReader(label = ""): StreamProgressReader {
  const seen = new Set<string>();
  const order: string[] = [];
  const noted = new Set<string>();
  const prefix = label ? `[runpod-stream ${label}]` : "[runpod-stream]";
  let emptyReads = 0;
  let reportedChunks = false;

  function note(message: string) {
    if (noted.has(message)) return;
    noted.add(message);
    console.log(`${prefix} ${message}`);
  }

  return {
    note,
    read(payload: unknown) {
      const chunks: StreamProgressChunk[] = [];
      for (const raw of streamChunks(payload)) {
        for (const text of collectText(raw)) {
          const signature = text.length > 200 ? `${text.length}:${text.slice(0, 120)}${text.slice(-60)}` : text;
          if (seen.has(signature)) continue;

          seen.add(signature);
          order.push(signature);
          while (order.length > MAX_REMEMBERED_CHUNKS) {
            const stale = order.shift();
            if (stale !== undefined) seen.delete(stale);
          }

          chunks.push({ text, nodeId: NODE_ID_PREFIX.exec(text)?.[1] });
        }
      }

      if (chunks.length && !reportedChunks) {
        reportedChunks = true;
        // The first real chunk settles what the worker emits and whether the
        // node prefix parses. Truncated because chunk text is worker-shaped and
        // can carry paths.
        const sample = chunks[0].text.slice(0, 120);
        const nodeIds = chunks.map((chunk) => chunk.nodeId).filter(Boolean);
        note(`emitting progress: ${chunks.length} chunk(s), nodeIds=${JSON.stringify(nodeIds)}, first=${JSON.stringify(sample)}`);
      } else if (!chunks.length && !reportedChunks) {
        emptyReads += 1;
      }

      return chunks;
    },
    summarize() {
      // Called once when polling ends, rather than after a fixed number of
      // polls. A poll-count threshold silently misses exactly the jobs that
      // finish quickly -- which is how this first failed to report anything at
      // all on a 23-second run against a warm worker.
      if (reportedChunks || emptyReads === 0) return;
      note(`no progress chunks in ${emptyReads} poll(s); this worker does not stream`);
    },
  };
}

function streamChunks(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const record = payload as Record<string, unknown>;
  const stream = record.stream;
  if (Array.isArray(stream)) return stream;
  if (stream !== undefined && stream !== null) return [stream];
  // Some responses put the payload at the top level instead of under `stream`.
  if (["output", "message", "progress", "log", "text"].some((key) => key in record)) return [record];
  return [];
}

/**
 * Every string worth showing inside a chunk.
 *
 * Depth-limited: these payloads are worker-shaped, not ours, and a pathological
 * one should cost a bounded walk rather than a stack.
 */
function collectText(value: unknown, depth = 0): string[] {
  if (depth > 4) return [];

  if (typeof value === "string") {
    const text = value.trim();
    return text ? [text] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectText(item, depth + 1));
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["progress", "message", "log", "text", "output"].flatMap((key) =>
      key in record ? collectText(record[key], depth + 1) : [],
    );
  }

  return [];
}
