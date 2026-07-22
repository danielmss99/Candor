const DEFAULT_SEARCH_ATTEMPTS = 200;
const DEFAULT_SEARCH_RETRY_DELAY_MS = 25;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function searchWhenReady(
  call,
  params,
  {
    attempts = DEFAULT_SEARCH_ATTEMPTS,
    retryDelayMs = DEFAULT_SEARCH_RETRY_DELAY_MS,
  } = {},
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await call("recording.durable.search", params);
    } catch (error) {
      if (error?.code !== "RECORDING_SEARCH_INDEX_BUILDING") {
        throw error;
      }
      if (attempt + 1 >= attempts) {
        const exhausted = new Error(
          `encrypted search index did not become ready after ${attempts} attempts`,
          {
            cause: error,
          },
        );
        exhausted.code = error.code;
        exhausted.attempts = attempts;
        throw exhausted;
      }
      await delay(retryDelayMs);
    }
  }
  throw new Error("encrypted search retry bound was invalid");
}
