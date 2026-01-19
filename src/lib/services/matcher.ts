/**
 * Improved track matching logic with better normalization and multi-candidate scoring.
 */

import { logger } from '../logger';
import { QobuzClient, QobuzTrack } from './qobuz';
import type { SpotifyTrack } from './spotify';
import type { Suggestion } from '../types';

export interface MatchResult {
  qobuzTrack: QobuzTrack;
  matchType: 'isrc' | 'fuzzy' | 'fuzzy_album' | 'fuzzy_clean' | 'fuzzy_primary' | 'fuzzy_artist' | 'fuzzy_title';
  score: number;
}

// Thresholds
const TITLE_THRESHOLD = 75;
const ARTIST_THRESHOLD = 70;
const DURATION_TOLERANCE_MS = 10000;
const MIN_COMBINED_SCORE = 78;
const MIN_ARTIST_SCORE_FOR_SUGGESTION = 60; // Increased from 50 to reduce bad suggestions
const MIN_TOKEN_OVERLAP_FOR_SUGGESTION = 1; // Require at least one common token in artist names

/**
 * Normalize ISRC codes for comparison.
 * ISRCs can appear with or without hyphens: USRC17607839 vs US-RC1-76-07839
 */
function normalizeIsrc(isrc: string): string {
  return isrc.toUpperCase().replace(/[-\s]/g, '');
}

// Patterns for normalization
const FEAT_PATTERN = /\s*[([](feat\.?|ft\.?|featuring|with|prod\.?|produced by)[^\])]*[\])]/gi;
const FEAT_INLINE_PATTERN = /\s+(feat\.?|ft\.?|featuring|with)\s+.+$/gi;
const REMASTER_PATTERN = /\s*[([].*?(remaster|remix|version|edit|mix|live|acoustic|radio|single|album|deluxe|bonus|extended|original|anniversary|\d{4}).*?[\])]/gi;
const EXTRA_INFO_PATTERN = /\s*[([].*?[\])]/gi;
const THE_PREFIX = /^the\s+/i;
const SPECIAL_CHARS = /[^\w\s]/g;

// Known duo/group artists that should NOT be split
const KNOWN_DUOS = new Set([
  'simon & garfunkel', 'simon and garfunkel',
  'hall & oates', 'hall and oates',
  'crosby, stills & nash', 'crosby, stills, nash & young',
  'earth, wind & fire', 'earth wind & fire',
  'emerson, lake & palmer',
  'peter, paul & mary', 'peter, paul and mary',
  'tears for fears',
  'the mamas & the papas', 'mamas and papas',
  'florence + the machine', 'florence and the machine',
  'belle & sebastian', 'belle and sebastian',
  'tegan & sara', 'tegan and sara',
  'penn & teller',
  'brooks & dunn',
  'blood, sweat & tears',
  "tony! toni! toné!",
  'three dog night',
]);

/**
 * Calculate fuzzy similarity ratio between two strings (0-100).
 * Uses Levenshtein distance.
 */
export function fuzzyRatio(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 100;

  const len1 = s1.length;
  const len2 = s2.length;
  const maxLen = Math.max(len1, len2);

  if (maxLen === 0) return 100;

  // Levenshtein distance
  const matrix: number[][] = [];
  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  const distance = matrix[len1][len2];
  return Math.round((1 - distance / maxLen) * 100);
}

/**
 * Token sort ratio - handles word order differences.
 */
function tokenSortRatio(s1: string, s2: string): number {
  const tokens1 = s1.split(/\s+/).sort().join(' ');
  const tokens2 = s2.split(/\s+/).sort().join(' ');
  return fuzzyRatio(tokens1, tokens2);
}

/**
 * Token set ratio - handles subset matches.
 */
function tokenSetRatio(s1: string, s2: string): number {
  const tokens1 = new Set(s1.split(/\s+/));
  const tokens2 = new Set(s2.split(/\s+/));
  const intersection = [...tokens1].filter(t => tokens2.has(t));
  const diff1 = [...tokens1].filter(t => !tokens2.has(t));
  const diff2 = [...tokens2].filter(t => !tokens1.has(t));

  const sorted1 = [...intersection].sort().join(' ');
  const sorted2 = [...intersection, ...diff1].sort().join(' ');
  const sorted3 = [...intersection, ...diff2].sort().join(' ');

  return Math.max(
    fuzzyRatio(sorted1, sorted2),
    fuzzyRatio(sorted1, sorted3),
    fuzzyRatio(sorted2, sorted3)
  );
}

/**
 * Partial ratio - handles substring matches.
 */
function partialRatio(s1: string, s2: string): number {
  const [shorter, longer] = s1.length <= s2.length ? [s1, s2] : [s2, s1];
  const shortLen = shorter.length;

  let bestScore = 0;
  for (let i = 0; i <= longer.length - shortLen; i++) {
    const substr = longer.substring(i, i + shortLen);
    const score = fuzzyRatio(shorter, substr);
    if (score > bestScore) bestScore = score;
  }

  return bestScore;
}

/**
 * Best fuzzy score using multiple algorithms.
 * Exported for use in album matching.
 */
export function bestFuzzyScore(s1: string, s2: string): number {
  return Math.max(
    fuzzyRatio(s1, s2),
    tokenSortRatio(s1, s2),
    tokenSetRatio(s1, s2),
    partialRatio(s1, s2)
  );
}

// Localized spelling variations
const LOCALIZED_SPELLINGS: [RegExp, string][] = [
  [/colour/g, 'color'],
  [/favour/g, 'favor'],
  [/behaviour/g, 'behavior'],
  [/honour/g, 'honor'],
  [/neighbour/g, 'neighbor'],
  [/centre/g, 'center'],
  [/theatre/g, 'theater'],
  [/defence/g, 'defense'],
  [/licence/g, 'license'],
  [/grey/g, 'gray'],
  [/catalogue/g, 'catalog'],
  [/dialogue/g, 'dialog'],
  [/travelling/g, 'traveling'],
  [/cancelled/g, 'canceled'],
];

/**
 * Check if two strings have overlapping tokens (words).
 * Returns the count of common tokens.
 */
function getTokenOverlap(s1: string, s2: string): number {
  if (!s1 || !s2) return 0;
  const tokens1 = new Set(s1.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  const tokens2 = new Set(s2.toLowerCase().split(/\s+/).filter(t => t.length > 1));
  return [...tokens1].filter(t => tokens2.has(t)).length;
}

/**
 * Normalize string for comparison.
 */
function normalize(s: string): string {
  if (!s) return '';

  let result = s.toLowerCase().trim();

  // Remove accents
  result = result.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  // Apply localized spelling normalization
  for (const [pattern, replacement] of LOCALIZED_SPELLINGS) {
    result = result.replace(pattern, replacement);
  }

  // Remove featuring info in parentheses
  result = result.replace(FEAT_PATTERN, '');

  // Remove remaster/remix/version info
  result = result.replace(REMASTER_PATTERN, '');

  // Remove inline featuring
  result = result.replace(FEAT_INLINE_PATTERN, '');

  // Normalize "and" / "&"
  result = result.replace(' & ', ' and ');

  // Remove "the" prefix
  result = result.replace(THE_PREFIX, '');

  // Collapse multiple spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * More aggressive normalization for fallback matching.
 */
function normalizeAggressive(s: string): string {
  if (!s) return '';

  let result = normalize(s);

  // Remove ALL parenthetical content
  result = result.replace(EXTRA_INFO_PATTERN, '');

  // Remove special characters except spaces
  result = result.replace(SPECIAL_CHARS, ' ');

  // Collapse spaces
  result = result.replace(/\s+/g, ' ').trim();

  return result;
}

/**
 * Extract primary artist and featured artists from artist string.
 */
function extractFeaturedArtists(s: string): { primary: string; featured: string[] } {
  if (!s) return { primary: s, featured: [] };

  const sLower = s.toLowerCase().trim();

  // Check if this is a known duo/group - don't split
  for (const duo of KNOWN_DUOS) {
    if (sLower.includes(duo) || duo.includes(sLower)) {
      return { primary: s, featured: [] };
    }
  }

  // Pattern: "Primary Artist feat./ft./featuring Other Artists"
  const featMatch = s.match(/^(.+?)\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$/i);
  if (featMatch) {
    const primary = featMatch[1].trim();
    const others = featMatch[2];
    const featured = others.split(/\s*[,&]\s*|\s+and\s+/i).map(a => a.trim()).filter(Boolean);
    return { primary, featured };
  }

  // Pattern: parenthetical featuring
  const parenMatch = s.match(/^(.+?)\s*[([](feat\.?|ft\.?|featuring)\s+([^\])]+)[\])]/i);
  if (parenMatch) {
    const primary = parenMatch[1].trim();
    const others = parenMatch[3];
    const featured = others.split(/\s*[,&]\s*|\s+and\s+/i).map(a => a.trim()).filter(Boolean);
    return { primary, featured };
  }

  return { primary: s, featured: [] };
}

/**
 * Get dynamic duration tolerance based on track length.
 */
function getDurationTolerance(durationMs: number): number {
  if (durationMs < 120000) return 3000;      // < 2 min: 3 seconds
  if (durationMs < 240000) return 5000;      // < 4 min: 5 seconds
  if (durationMs < 480000) return 10000;     // < 8 min: 10 seconds
  return 30000;                              // Long tracks: 30 seconds
}

/**
 * Check if album name suggests it's a compilation.
 */
function isCompilationAlbum(albumName: string): boolean {
  const keywords = [
    'greatest hits', 'best of', 'collection', 'anthology',
    'essential', 'ultimate', 'complete', 'definitive',
    'gold', 'platinum', 'legend', 'classics',
    'hits', 'singles', 'compilation', 'various artists',
    'soundtrack', 'ost', "now that's what i call",
  ];
  const lower = albumName.toLowerCase();
  return keywords.some(kw => lower.includes(kw));
}

export class TrackMatcher {
  private qobuzClient: QobuzClient;
  private prebuiltIsrcMap: Map<string, number> | null = null;

  constructor(qobuzClient: QobuzClient) {
    this.qobuzClient = qobuzClient;
  }

  /**
   * Set a pre-built ISRC map for instant lookups without API calls.
   * Map keys should be normalized ISRCs (uppercase, no hyphens).
   */
  setIsrcMap(isrcMap: Map<string, number>): void {
    // Normalize all keys in the map
    this.prebuiltIsrcMap = new Map();
    for (const [isrc, trackId] of isrcMap) {
      this.prebuiltIsrcMap.set(normalizeIsrc(isrc), trackId);
    }
  }

  /**
   * Match a Spotify track to a Qobuz track.
   */
  async matchTrack(spotifyTrack: SpotifyTrack): Promise<MatchResult | null> {
    const [result] = await this.matchTrackWithSuggestions(spotifyTrack);
    return result;
  }

  /**
   * Match a Spotify track and return near-miss suggestions if no match found.
   */
  async matchTrackWithSuggestions(
    spotifyTrack: SpotifyTrack,
    suggestionThreshold: number = 40.0
  ): Promise<[MatchResult | null, Suggestion[]]> {
    // Try ISRC matching first
    if (spotifyTrack.isrc) {
      const result = await this.matchByIsrc(spotifyTrack);
      if (result) return [result, []];
    }

    // Get candidates for fuzzy matching
    const candidates = await this.qobuzClient.searchCandidates(
      spotifyTrack.title,
      spotifyTrack.artist
    );

    // Check if any candidate has matching ISRC (cross-verification)
    // This catches cases where ISRC search failed but fuzzy search found it
    if (spotifyTrack.isrc) {
      const normalizedSpotifyIsrc = normalizeIsrc(spotifyTrack.isrc);
      for (const candidate of candidates) {
        if (candidate.isrc && normalizeIsrc(candidate.isrc) === normalizedSpotifyIsrc) {
          logger.info(
            `ISRC cross-verified in fuzzy candidates: ${spotifyTrack.title} by ${spotifyTrack.artist} -> ` +
            `${candidate.title} by ${candidate.artist}`
          );
          return [{
            qobuzTrack: candidate,
            matchType: 'isrc',
            score: 100,
          }, []];
        }
      }
    }

    // Score all candidates
    const scoredCandidates = candidates.map(candidate => {
      const { titleScore, artistScore, combined } = this.scoreCandidateDetailed(
        spotifyTrack,
        candidate
      );
      const durationDiff = Math.abs(spotifyTrack.duration - candidate.duration);
      return { candidate, score: combined, titleScore, artistScore, durationDiff };
    });

    // Sort by score
    scoredCandidates.sort((a, b) => b.score - a.score);

    // Check for a good match
    const durationTolerance = getDurationTolerance(spotifyTrack.duration);
    if (scoredCandidates.length > 0) {
      const best = scoredCandidates[0];
      if (best.score >= MIN_COMBINED_SCORE && best.durationDiff <= durationTolerance) {
        logger.info(
          `Fuzzy match (score=${best.score.toFixed(1)}): ` +
          `${spotifyTrack.title} by ${spotifyTrack.artist} -> ` +
          `${best.candidate.title} by ${best.candidate.artist}`
        );
        return [{
          qobuzTrack: best.candidate,
          matchType: 'fuzzy',
          score: best.score,
        }, []];
      }
    }

    // Try alternative search strategies
    const altResult = await this.matchAlternative(spotifyTrack);
    if (altResult) return [altResult, []];

    // No match - return suggestions with stricter filtering
    const suggestions: Suggestion[] = [];
    for (const sc of scoredCandidates.slice(0, 10)) {
      // Check basic score thresholds
      if (sc.score < suggestionThreshold || sc.artistScore < MIN_ARTIST_SCORE_FOR_SUGGESTION) {
        continue;
      }

      // Check for token overlap in artist names to filter out completely unrelated artists
      // Skip this check if artistScore is very high (>= 85) as that indicates a good match
      if (sc.artistScore < 85) {
        const tokenOverlap = getTokenOverlap(spotifyTrack.artist, sc.candidate.artist);
        if (tokenOverlap < MIN_TOKEN_OVERLAP_FOR_SUGGESTION) {
          // Also check if any Spotify artist appears in the candidate artist
          const allSpotifyArtists = spotifyTrack.allArtists?.length > 0
            ? spotifyTrack.allArtists
            : [spotifyTrack.artist];
          const hasAnyOverlap = allSpotifyArtists.some(
            sArtist => getTokenOverlap(sArtist, sc.candidate.artist) >= MIN_TOKEN_OVERLAP_FOR_SUGGESTION
          );
          if (!hasAnyOverlap) {
            continue;
          }
        }
      }

      suggestions.push({
        qobuz_id: sc.candidate.id,
        title: sc.candidate.title,
        artist: sc.candidate.artist,
        album: sc.candidate.album,
        score: Math.round(sc.score * 10) / 10,
        title_score: Math.round(sc.titleScore * 10) / 10,
        artist_score: Math.round(sc.artistScore * 10) / 10,
        duration_diff_sec: Math.round(sc.durationDiff / 100) / 10,
      });
      if (suggestions.length >= 5) break;
    }

    return [null, suggestions];
  }

  private async matchByIsrc(spotifyTrack: SpotifyTrack): Promise<MatchResult | null> {
    if (!spotifyTrack.isrc) return null;

    const normalizedIsrc = normalizeIsrc(spotifyTrack.isrc);

    // Fast path: check prebuilt ISRC map first (no API call needed)
    if (this.prebuiltIsrcMap?.has(normalizedIsrc)) {
      const trackId = this.prebuiltIsrcMap.get(normalizedIsrc)!;
      logger.info(
        `ISRC instant match (from cache): ${spotifyTrack.title} by ${spotifyTrack.artist} -> track ID ${trackId}`
      );
      // Return minimal track info - the ID is what matters for adding to favorites
      return {
        qobuzTrack: {
          id: trackId,
          title: spotifyTrack.title,
          artist: spotifyTrack.artist,
          album: spotifyTrack.album,
          duration: spotifyTrack.duration,
          isrc: spotifyTrack.isrc,
        },
        matchType: 'isrc',
        score: 100,
      };
    }

    // Slow path: API search
    const qobuzTrack = await this.qobuzClient.searchByIsrc(
      spotifyTrack.isrc,
      spotifyTrack.title,
      spotifyTrack.artist
    );

    if (qobuzTrack) {
      logger.info(
        `ISRC match: ${spotifyTrack.title} by ${spotifyTrack.artist} -> ` +
        `${qobuzTrack.title} by ${qobuzTrack.artist}`
      );
      return {
        qobuzTrack,
        matchType: 'isrc',
        score: 100,
      };
    }

    return null;
  }

  private async matchAlternative(spotifyTrack: SpotifyTrack): Promise<MatchResult | null> {
    const { title, artist, album } = spotifyTrack;
    const durationTolerance = getDurationTolerance(spotifyTrack.duration);
    const cleanTitle = normalizeAggressive(title);
    const cleanArtist = normalizeAggressive(artist);
    const { primary, featured } = extractFeaturedArtists(artist);

    // Build search queries for parallel execution
    type SearchTask = {
      type: MatchResult['matchType'];
      query: [string, string];
      enabled: boolean;
    };

    // Build partial title for artist-focused search
    const titleWords = title.split(/\s+/).filter(w => w.length > 2);
    const partialTitle = titleWords.length > 0 ? titleWords.slice(0, 2).join(' ') : '';

    const searchTasks: SearchTask[] = [
      // Strategy 1: Search with album name for disambiguation
      { type: 'fuzzy_album', query: [title, album || ''], enabled: !!album },
      // Strategy 2: Clean title aggressively
      { type: 'fuzzy_clean', query: [cleanTitle, cleanArtist], enabled: cleanTitle !== normalize(title) },
      // Strategy 3: Primary artist only
      { type: 'fuzzy_primary', query: [title, primary], enabled: featured.length > 0 },
      // Strategy 4: Artist-focused search - search by artist with first word(s) of title
      { type: 'fuzzy_artist', query: [partialTitle, artist], enabled: partialTitle.length > 0 },
      // Strategy 5: Title-only search
      { type: 'fuzzy_title', query: [title, ''], enabled: true },
    ];

    // Execute all enabled searches in parallel
    const enabledTasks = searchTasks.filter(t => t.enabled);
    const searchPromises = enabledTasks.map(task =>
      this.qobuzClient.searchCandidates(task.query[0], task.query[1])
        .then(candidates => ({ type: task.type, candidates }))
        .catch(() => ({ type: task.type, candidates: [] }))
    );

    const results = await Promise.all(searchPromises);

    // Process results in priority order (album > clean > primary > artist > title)
    for (const { type, candidates } of results) {
      for (const candidate of candidates) {
        const durationDiff = Math.abs(spotifyTrack.duration - candidate.duration);
        const titleScore = bestFuzzyScore(normalize(title), normalize(candidate.title));
        const artistScore = bestFuzzyScore(normalize(artist), normalize(candidate.artist));

        if (type === 'fuzzy_title') {
          // Special scoring for title-focused search
          if (titleScore >= 92 && artistScore >= 40 && durationDiff <= 3000) {
            const score = titleScore * 0.7 + artistScore * 0.3;
            logger.info(
              `Title-focused match (title=${titleScore.toFixed(1)}, artist=${artistScore.toFixed(1)}): ` +
              `${title} by ${artist} -> ${candidate.title} by ${candidate.artist}`
            );
            return { qobuzTrack: candidate, matchType: type, score };
          }
        } else if (type === 'fuzzy_artist') {
          // Artist-focused: require strong artist match but more flexible title matching
          if (artistScore >= 85 && titleScore >= 70 && durationDiff <= durationTolerance) {
            const score = titleScore * 0.4 + artistScore * 0.6;
            logger.info(
              `Artist-focused match (title=${titleScore.toFixed(1)}, artist=${artistScore.toFixed(1)}): ` +
              `${title} by ${artist} -> ${candidate.title} by ${candidate.artist}`
            );
            return { qobuzTrack: candidate, matchType: type, score };
          }
        } else {
          // Standard scoring for other strategies
          const score = this.scoreCandidate(spotifyTrack, candidate);
          if (score >= 65 && durationDiff <= durationTolerance) {
            logger.info(
              `${type} match (score=${score.toFixed(1)}): ` +
              `${title} by ${artist} -> ${candidate.title} by ${candidate.artist}`
            );
            return { qobuzTrack: candidate, matchType: type, score };
          }
        }
      }
    }

    return null;
  }

  private scoreCandidate(spotifyTrack: SpotifyTrack, candidate: QobuzTrack): number {
    const { combined } = this.scoreCandidateDetailed(spotifyTrack, candidate);
    return combined;
  }

  private scoreCandidateDetailed(
    spotifyTrack: SpotifyTrack,
    candidate: QobuzTrack
  ): { titleScore: number; artistScore: number; combined: number } {
    const spotifyTitle = normalize(spotifyTrack.title);
    const spotifyArtist = normalize(spotifyTrack.artist);
    const candidateTitle = normalize(candidate.title);
    const candidateArtist = normalize(candidate.artist);

    // Calculate title score
    const titleScore = bestFuzzyScore(spotifyTitle, candidateTitle);

    // Calculate artist scores - try multiple approaches
    const artistScores = [bestFuzzyScore(spotifyArtist, candidateArtist)];

    // Use allArtists if available for better collaboration matching
    const allSpotifyArtists = spotifyTrack.allArtists?.length > 0
      ? spotifyTrack.allArtists
      : [spotifyTrack.artist];

    // Match each Spotify artist against the Qobuz artist
    for (const sArtist of allSpotifyArtists) {
      const score = bestFuzzyScore(normalize(sArtist), candidateArtist);
      artistScores.push(score);
    }

    // Extract and match featured artists from the artist string
    const spotifyParsed = extractFeaturedArtists(spotifyTrack.artist);
    const candidateParsed = extractFeaturedArtists(candidate.artist);

    // Primary artist match
    const primaryScore = bestFuzzyScore(
      normalize(spotifyParsed.primary),
      normalize(candidateParsed.primary)
    );
    artistScores.push(primaryScore);

    // Cross-match all Spotify artists with candidate featured artists
    // Note: allSpotifyArtists already includes all artists from the API,
    // so featured artists parsed from the string are covered here
    const allCandidateArtists = [candidateParsed.primary, ...candidateParsed.featured];
    for (const sArtist of allSpotifyArtists) {
      for (const cArtist of allCandidateArtists) {
        const crossScore = bestFuzzyScore(normalize(sArtist), normalize(cArtist));
        if (crossScore > 80) {
          artistScores.push(crossScore);
        }
      }
    }

    // Also check if any artist appears in track title
    for (const sArtist of allSpotifyArtists) {
      const artistInTitle = partialRatio(normalize(sArtist), candidateTitle);
      if (artistInTitle > 70) {
        artistScores.push(artistInTitle);
      }
    }

    const artistScore = Math.max(...artistScores);

    // Combined score - equal weighting
    let combined = titleScore * 0.5 + artistScore * 0.5;

    // Album matching bonus/penalty
    const spotifyAlbum = normalize(spotifyTrack.album);
    const candidateAlbum = normalize(candidate.album);
    if (spotifyAlbum && candidateAlbum) {
      const albumScore = tokenSortRatio(spotifyAlbum, candidateAlbum);
      if (albumScore > 85) {
        combined = Math.min(100, combined + 8);
      } else if (albumScore > 70) {
        combined = Math.min(100, combined + 4);
      } else if (isCompilationAlbum(candidateAlbum) && !isCompilationAlbum(spotifyAlbum)) {
        combined = Math.max(0, combined - 5);
      }
    }

    return { titleScore, artistScore, combined };
  }
}

export { Suggestion };
