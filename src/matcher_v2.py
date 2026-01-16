"""Improved track matching logic with better normalization and multi-candidate scoring."""

import re
import unicodedata
from typing import Dict, List, Optional, Tuple
from rapidfuzz import fuzz
from src.qobuz_client import QobuzClient
from src.utils.logger import get_logger


logger = get_logger()


class MatchResult:
    """Result of a track matching operation."""

    def __init__(
        self,
        qobuz_track: Dict,
        match_type: str,
        score: float
    ):
        self.qobuz_track = qobuz_track
        self.match_type = match_type
        self.score = score

    def __repr__(self) -> str:
        return f"MatchResult(type={self.match_type}, score={self.score:.2f})"


class TrackMatcherV2:
    """
    Improved matcher with:
    - Multi-candidate scoring (check all search results)
    - Better string normalization
    - Multiple fuzzy algorithms
    - Album-based disambiguation
    """

    # Thresholds
    TITLE_THRESHOLD = 75
    ARTIST_THRESHOLD = 70
    DURATION_TOLERANCE_MS = 10000  # 10 seconds (more lenient for remasters)
    MIN_COMBINED_SCORE = 70

    # Patterns for normalization
    FEAT_PATTERN = re.compile(
        r'\s*[\(\[](feat\.?|ft\.?|featuring|with|prod\.?|produced by)[^\)\]]*[\)\]]',
        re.IGNORECASE
    )
    FEAT_INLINE_PATTERN = re.compile(
        r'\s+(feat\.?|ft\.?|featuring|with)\s+.+$',
        re.IGNORECASE
    )
    REMASTER_PATTERN = re.compile(
        r'\s*[\(\[].*?(remaster|remix|version|edit|mix|live|acoustic|radio|single|album|deluxe|bonus|extended|original|anniversary|\d{4}).*?[\)\]]',
        re.IGNORECASE
    )
    EXTRA_INFO_PATTERN = re.compile(
        r'\s*[\(\[].*?[\)\]]',
        re.IGNORECASE
    )
    THE_PREFIX = re.compile(r'^the\s+', re.IGNORECASE)
    SPECIAL_CHARS = re.compile(r'[^\w\s]')

    def __init__(self, qobuz_client: QobuzClient):
        self.qobuz_client = qobuz_client

    def match_track(self, spotify_track: Dict) -> Optional[MatchResult]:
        """
        Match a Spotify track to a Qobuz track.

        Strategy:
        1. Try ISRC matching first (exact match)
        2. Try fuzzy matching with multiple candidates
        3. Try alternative search queries if needed
        """
        result, _ = self.match_track_with_suggestions(spotify_track)
        return result

    def match_track_with_suggestions(
        self,
        spotify_track: Dict,
        suggestion_threshold: float = 40.0
    ) -> Tuple[Optional[MatchResult], List[Dict]]:
        """
        Match a Spotify track and return near-miss suggestions if no match found.

        Returns:
            Tuple of (match_result, suggestions)
            - match_result: The matched track or None
            - suggestions: List of potential matches with scores (if no match found)
        """
        # Try ISRC matching first
        if spotify_track.get('isrc'):
            result = self._match_by_isrc(spotify_track)
            if result:
                return result, []

        # Get candidates for fuzzy matching
        candidates = self._search_candidates(
            spotify_track['title'],
            spotify_track['artist']
        )

        # Score all candidates
        scored_candidates = []
        for candidate in candidates:
            score = self._score_candidate(spotify_track, candidate)
            duration_diff = abs(spotify_track['duration'] - candidate['duration'])
            scored_candidates.append({
                'candidate': candidate,
                'score': score,
                'duration_diff': duration_diff
            })

        # Sort by score
        scored_candidates.sort(key=lambda x: x['score'], reverse=True)

        # Check for a good match
        if scored_candidates:
            best = scored_candidates[0]
            if (best['score'] >= self.MIN_COMBINED_SCORE and
                best['duration_diff'] <= self.DURATION_TOLERANCE_MS):
                logger.info(
                    f"Fuzzy match (score={best['score']:.1f}): "
                    f"{spotify_track['title']} by {spotify_track['artist']} "
                    f"-> {best['candidate']['title']} by {best['candidate']['artist']}"
                )
                return MatchResult(
                    qobuz_track=best['candidate'],
                    match_type='fuzzy',
                    score=best['score']
                ), []

        # Try alternative search strategies
        result = self._match_alternative(spotify_track)
        if result:
            return result, []

        # No match - return suggestions
        suggestions = []
        for sc in scored_candidates[:5]:  # Top 5 suggestions
            if sc['score'] >= suggestion_threshold:
                suggestions.append({
                    'qobuz_id': sc['candidate']['id'],
                    'title': sc['candidate']['title'],
                    'artist': sc['candidate']['artist'],
                    'album': sc['candidate']['album'],
                    'score': round(sc['score'], 1),
                    'duration_diff_sec': round(sc['duration_diff'] / 1000, 1)
                })

        return None, suggestions

    def _match_by_isrc(self, spotify_track: Dict) -> Optional[MatchResult]:
        """Match track using ISRC code."""
        isrc = spotify_track['isrc']
        qobuz_track = self.qobuz_client.search_by_isrc(isrc)

        if qobuz_track:
            logger.info(
                f"ISRC match: {spotify_track['title']} by {spotify_track['artist']} "
                f"-> {qobuz_track['title']} by {qobuz_track['artist']}"
            )
            return MatchResult(
                qobuz_track=qobuz_track,
                match_type='isrc',
                score=100.0
            )

        return None

    def _match_by_fuzzy_multi(self, spotify_track: Dict) -> Optional[MatchResult]:
        """
        Match track using fuzzy matching against ALL search results.
        Returns the best match above threshold.
        """
        # Get multiple candidates from Qobuz
        candidates = self._search_candidates(
            spotify_track['title'],
            spotify_track['artist']
        )

        if not candidates:
            return None

        # Score each candidate and find the best
        best_match = None
        best_score = 0

        for candidate in candidates:
            score = self._score_candidate(spotify_track, candidate)
            if score > best_score:
                best_score = score
                best_match = candidate

        if best_match and best_score >= self.MIN_COMBINED_SCORE:
            # Verify duration
            duration_diff = abs(spotify_track['duration'] - best_match['duration'])
            if duration_diff <= self.DURATION_TOLERANCE_MS:
                logger.info(
                    f"Fuzzy match (score={best_score:.1f}): "
                    f"{spotify_track['title']} by {spotify_track['artist']} "
                    f"-> {best_match['title']} by {best_match['artist']}"
                )
                return MatchResult(
                    qobuz_track=best_match,
                    match_type='fuzzy',
                    score=best_score
                )

        return None

    def _match_alternative(self, spotify_track: Dict) -> Optional[MatchResult]:
        """
        Try alternative search strategies for hard-to-match tracks.
        """
        title = spotify_track['title']
        artist = spotify_track['artist']
        album = spotify_track.get('album', '')

        # Strategy 1: Search with album name for disambiguation
        if album:
            candidates = self._search_candidates(title, album)
            for candidate in candidates:
                score = self._score_candidate(spotify_track, candidate)
                duration_diff = abs(spotify_track['duration'] - candidate['duration'])
                if score >= 65 and duration_diff <= self.DURATION_TOLERANCE_MS:
                    logger.info(
                        f"Album-based match (score={score:.1f}): "
                        f"{title} by {artist} "
                        f"-> {candidate['title']} by {candidate['artist']}"
                    )
                    return MatchResult(
                        qobuz_track=candidate,
                        match_type='fuzzy_album',
                        score=score
                    )

        # Strategy 2: Clean title aggressively and retry
        clean_title = self._normalize_aggressive(title)
        clean_artist = self._normalize_aggressive(artist)

        if clean_title != self._normalize(title):
            candidates = self._search_candidates(clean_title, clean_artist)
            for candidate in candidates:
                score = self._score_candidate(spotify_track, candidate)
                duration_diff = abs(spotify_track['duration'] - candidate['duration'])
                if score >= 65 and duration_diff <= self.DURATION_TOLERANCE_MS:
                    logger.info(
                        f"Clean title match (score={score:.1f}): "
                        f"{title} by {artist} "
                        f"-> {candidate['title']} by {candidate['artist']}"
                    )
                    return MatchResult(
                        qobuz_track=candidate,
                        match_type='fuzzy_clean',
                        score=score
                    )

        # Strategy 3: Title only search (for cases where artist name differs significantly)
        candidates = self._search_candidates(title, "")
        for candidate in candidates:
            title_score = self._fuzzy_score(
                self._normalize(title),
                self._normalize(candidate['title'])
            )
            duration_diff = abs(spotify_track['duration'] - candidate['duration'])
            # Require high title match and close duration
            if title_score >= 90 and duration_diff <= 3000:
                logger.info(
                    f"Title-only match (title_score={title_score:.1f}): "
                    f"{title} by {artist} "
                    f"-> {candidate['title']} by {candidate['artist']}"
                )
                return MatchResult(
                    qobuz_track=candidate,
                    match_type='fuzzy_title',
                    score=title_score
                )

        return None

    def _search_candidates(self, title: str, artist: str) -> List[Dict]:
        """Search Qobuz and return multiple candidate tracks."""
        query = f"{title} {artist}".strip()
        if not query:
            return []

        try:
            params = {
                'query': query,
                'limit': 15  # Get more candidates
            }
            data = self.qobuz_client._make_request('track/search', params)

            if data.get('tracks', {}).get('total', 0) == 0:
                return []

            candidates = []
            for item in data['tracks']['items']:
                candidates.append({
                    'id': item['id'],
                    'title': item['title'],
                    'artist': item['performer']['name'],
                    'album': item['album']['title'],
                    'duration': item['duration'] * 1000  # Convert to ms
                })

            return candidates

        except Exception as e:
            logger.error(f"Error searching candidates: {e}")
            return []

    def _score_candidate(self, spotify_track: Dict, candidate: Dict) -> float:
        """
        Score a candidate track against the Spotify track.
        Uses multiple fuzzy algorithms and weights.
        """
        spotify_title = self._normalize(spotify_track['title'])
        spotify_artist = self._normalize(spotify_track['artist'])
        candidate_title = self._normalize(candidate['title'])
        candidate_artist = self._normalize(candidate['artist'])

        # Calculate title scores with multiple algorithms
        title_score = self._fuzzy_score(spotify_title, candidate_title)

        # Calculate artist scores
        artist_score = self._fuzzy_score(spotify_artist, candidate_artist)

        # Also check if artist appears in track title (common for features)
        artist_in_title = fuzz.partial_ratio(spotify_artist, candidate_title)
        if artist_in_title > artist_score:
            artist_score = (artist_score + artist_in_title) / 2

        # Combined score (title weighted more heavily)
        combined = (title_score * 0.6) + (artist_score * 0.4)

        # Bonus for matching album
        spotify_album = self._normalize(spotify_track.get('album', ''))
        candidate_album = self._normalize(candidate.get('album', ''))
        if spotify_album and candidate_album:
            album_score = fuzz.token_sort_ratio(spotify_album, candidate_album)
            if album_score > 80:
                combined = min(100, combined + 5)

        return combined

    def _fuzzy_score(self, s1: str, s2: str) -> float:
        """
        Calculate fuzzy score using multiple algorithms and return best.
        """
        scores = [
            fuzz.ratio(s1, s2),
            fuzz.token_sort_ratio(s1, s2),  # Order-independent
            fuzz.token_set_ratio(s1, s2),   # Handles subsets
            fuzz.partial_ratio(s1, s2),     # Handles partial matches
        ]
        return max(scores)

    def _normalize(self, s: str) -> str:
        """
        Normalize string for comparison.
        Handles common variations in track/artist names.
        """
        if not s:
            return ""

        # Lowercase and strip
        result = s.lower().strip()

        # Remove accents
        result = unicodedata.normalize('NFD', result)
        result = ''.join(c for c in result if unicodedata.category(c) != 'Mn')

        # Remove featuring info in parentheses
        result = self.FEAT_PATTERN.sub('', result)

        # Remove remaster/remix/version info
        result = self.REMASTER_PATTERN.sub('', result)

        # Remove inline featuring
        result = self.FEAT_INLINE_PATTERN.sub('', result)

        # Normalize "and" / "&"
        result = result.replace(' & ', ' and ')

        # Remove "the" prefix for artists
        result = self.THE_PREFIX.sub('', result)

        # Collapse multiple spaces
        result = ' '.join(result.split())

        return result.strip()

    def _normalize_aggressive(self, s: str) -> str:
        """
        More aggressive normalization for fallback matching.
        Removes ALL parenthetical content and special characters.
        """
        if not s:
            return ""

        result = self._normalize(s)

        # Remove ALL parenthetical content
        result = self.EXTRA_INFO_PATTERN.sub('', result)

        # Remove special characters except spaces
        result = self.SPECIAL_CHARS.sub(' ', result)

        # Collapse spaces
        result = ' '.join(result.split())

        return result.strip()


# Alias for easy switching
TrackMatcher = TrackMatcherV2
