import { listenSentinelHttp } from './http.ts';
import { loadLiveCompanionContext } from './live-context.ts';

listenSentinelHttp({ contextProvider: loadLiveCompanionContext });
