// A shared allowance for work a stranger can make this service do: a token
// bucket, refilled continuously. Used where one request becomes a call
// elsewhere (LI.FI's quota, another store), so a flood is refused here
// rather than spending what everyone shares.

/** True at most `perMinute` times a minute, in bursts of up to `perMinute`. */
export function rateLimit(perMinute: number, now: () => number = Date.now): () => boolean {
  let tokens = perMinute;
  let at = now();
  return () => {
    const t = now();
    tokens = Math.min(perMinute, tokens + ((t - at) * perMinute) / 60_000);
    at = t;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
