/**
 * Caption Track selection and timedtext parsing.
 *
 * Pure logic with no browser dependencies, so it can be tested in Node and
 * loaded by the service worker with importScripts.
 */
var YTD_CAPTIONS = (() => {
  function normalizedLanguage(track) {
    return String(track?.languageCode || "").toLowerCase();
  }

  function chineseLanguageGroup(track) {
    const code = normalizedLanguage(track);
    if (["zh", "zh-hans", "zh-cn", "zh-sg"].includes(code)) {
      return "zh-hans";
    }
    if (["zh-hant", "zh-tw", "zh-hk", "zh-mo"].includes(code)) {
      return "zh-hant";
    }
    return "";
  }

  function isEnglish(track) {
    const code = normalizedLanguage(track);
    return code === "en" || code.startsWith("en-");
  }

  function translatedTrack(track, languageCode) {
    const separator = track.baseUrl.includes("?") ? "&" : "?";
    return {
      ...track,
      baseUrl: `${track.baseUrl}${separator}tlang=${encodeURIComponent(languageCode)}`,
      languageCode,
      sourceLanguageCode: track.languageCode,
      isAutoTranslated: true,
    };
  }

  function withPlayerCaptionAuthorization(baseUrl, playerRequestUrl) {
    const candidate = new URL(baseUrl);
    const authorized = new URL(playerRequestUrl);
    const authorizationKeys = [
      "potc",
      "pot",
      "xorb",
      "xobt",
      "xovt",
      "cbrand",
      "cbr",
      "cbrver",
      "c",
      "cver",
      "cplayer",
      "cos",
      "cosver",
      "cplatform",
    ];
    for (const key of authorizationKeys) {
      const value = authorized.searchParams.get(key);
      if (value !== null) candidate.searchParams.set(key, value);
    }
    return candidate.toString();
  }

  function selectCaptionCandidates(tracks, translationLanguages) {
    if (!Array.isArray(tracks)) return [];
    const ordered = tracks
      .filter((track) => track?.baseUrl)
      .sort((a, b) => Number(a.kind === "asr") - Number(b.kind === "asr"));
    const availableTranslations = new Set(
      (Array.isArray(translationLanguages) ? translationLanguages : [])
        .map((language) => language?.languageCode)
        .filter(Boolean),
    );
    const candidates = [];

    function addDirect(predicate) {
      candidates.push(...ordered.filter(predicate));
    }

    function addTranslations(languageCodes) {
      for (const languageCode of languageCodes) {
        if (!availableTranslations.has(languageCode)) continue;
        const targetCode = languageCode.toLowerCase();
        const sources = ordered.filter((track) => {
          if (!track.isTranslatable) return false;
          return languageCode === "en"
            ? !isEnglish(track)
            : chineseLanguageGroup(track) !== targetCode;
        });
        candidates.push(
          ...sources.map((track) => translatedTrack(track, languageCode)),
        );
      }
    }

    addDirect((track) => chineseLanguageGroup(track) === "zh-hans");
    addDirect((track) => chineseLanguageGroup(track) === "zh-hant");
    addTranslations(["zh-Hans", "zh-Hant"]);
    addDirect(isEnglish);
    addTranslations(["en"]);
    return candidates;
  }

  function parseTimedtextJson3(json3, languageCode) {
    const events = json3?.events || [];
    const transcript = [];
    let transcriptTextPlain = "";
    let transcriptTextTimestamped = "";

    for (const event of events) {
      const segments = event.segs || [];
      // ">>" is the speaker-change marker in YouTube auto-captions.
      const text = segments
        .map((s) => s.utf8 || "")
        .join("")
        .replace(/>> ?/g, "")
        .trim();
      if (!text) continue;

      const startSeconds = Math.floor((event.tStartMs || 0) / 1000);
      const minutes = Math.floor(startSeconds / 60);
      const seconds = startSeconds % 60;
      const timestamp = `${minutes}:${String(seconds).padStart(2, "0")}`;

      transcript.push({
        text,
        start: startSeconds,
        duration: Math.floor((event.dDurationMs || 0) / 1000),
        language: languageCode,
      });

      transcriptTextPlain += text + " ";
      transcriptTextTimestamped += `[${timestamp}] ${text}\n`;
    }

    return {
      transcript,
      transcriptTextPlain: transcriptTextPlain.trim(),
      transcriptTextTimestamped: transcriptTextTimestamped.trim(),
    };
  }

  async function fetchCaptionTranscript(
    tracks,
    translationLanguages,
    fetchImpl,
    authorizeUrl = (url) => url,
  ) {
    const candidates = selectCaptionCandidates(tracks, translationLanguages);
    for (const selectedTrack of candidates) {
      try {
        const baseUrl = authorizeUrl(selectedTrack.baseUrl);
        const separator = baseUrl.includes("?") ? "&" : "?";
        const response = await fetchImpl(`${baseUrl}${separator}fmt=json3`);
        if (!response.ok) continue;
        const json3 = await response.json();
        const parsed = parseTimedtextJson3(
          json3,
          selectedTrack.languageCode,
        );
        if (parsed.transcript.length === 0) continue;
        return {
          success: true,
          transcript: parsed.transcript,
          transcriptText: parsed.transcriptTextPlain,
          transcriptTextTimestamped: parsed.transcriptTextTimestamped,
          language: selectedTrack.languageCode,
          captionKind: selectedTrack.kind === "asr" ? "asr" : "native",
        };
      } catch (_e) {
        // A listed track can still return an empty body or malformed JSON.
        // Try the next candidate rather than failing the whole transcript.
      }
    }
    return {
      success: false,
      error: "NO_SUITABLE_CAPTION",
      message: "抓取不到合适的字幕",
    };
  }

  return {
    selectCaptionCandidates,
    withPlayerCaptionAuthorization,
    fetchCaptionTranscript,
    parseTimedtextJson3,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = YTD_CAPTIONS;
}
