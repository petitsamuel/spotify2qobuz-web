"""Improved track matching logic with better normalization and multi-candidate scoring."""

import re
import unicodedata
from typing import Dict, List, Optional, Tuple
from rapidfuzz import fuzz
from src.qobuz_client import QobuzClient
from src.utils.logger import get_logger

# Optional: phonetic matching
try:
    import jellyfish
    HAS_JELLYFISH = True
except ImportError:
    HAS_JELLYFISH = False

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
    MIN_COMBINED_SCORE = 78  # Raised from 70 to reduce false positives

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

    # Minimum artist score required for suggestions (filter out wrong artists)
    MIN_ARTIST_SCORE_FOR_SUGGESTION = 50

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

        # Score all candidates with detailed breakdown
        scored_candidates = []
        for candidate in candidates:
            title_score, artist_score, combined = self._score_candidate_detailed(
                spotify_track, candidate
            )
            duration_diff = abs(spotify_track['duration'] - candidate['duration'])
            scored_candidates.append({
                'candidate': candidate,
                'score': combined,
                'title_score': title_score,
                'artist_score': artist_score,
                'duration_diff': duration_diff
            })

        # Sort by score
        scored_candidates.sort(key=lambda x: x['score'], reverse=True)

        # Check for a good match (use dynamic duration tolerance)
        duration_tolerance = self._get_duration_tolerance(spotify_track['duration'])
        if scored_candidates:
            best = scored_candidates[0]
            if (best['score'] >= self.MIN_COMBINED_SCORE and
                best['duration_diff'] <= duration_tolerance):
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

        # No match - return suggestions (filtered by minimum artist score)
        suggestions = []
        for sc in scored_candidates[:10]:  # Check more candidates
            # Require minimum artist match to filter out wrong artists
            if (sc['score'] >= suggestion_threshold and
                sc['artist_score'] >= self.MIN_ARTIST_SCORE_FOR_SUGGESTION):
                suggestions.append({
                    'qobuz_id': sc['candidate']['id'],
                    'title': sc['candidate']['title'],
                    'artist': sc['candidate']['artist'],
                    'album': sc['candidate']['album'],
                    'score': round(sc['score'], 1),
                    'title_score': round(sc['title_score'], 1),
                    'artist_score': round(sc['artist_score'], 1),
                    'duration_diff_sec': round(sc['duration_diff'] / 1000, 1)
                })
                if len(suggestions) >= 5:
                    break

        return None, suggestions

    def _match_by_isrc(self, spotify_track: Dict) -> Optional[MatchResult]:
        """Match track using ISRC code with title/artist hints for fallback."""
        isrc = spotify_track['isrc']
        qobuz_track = self.qobuz_client.search_by_isrc(
            isrc,
            title_hint=spotify_track.get('title'),
            artist_hint=spotify_track.get('artist')
        )

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
        duration_tolerance = self._get_duration_tolerance(spotify_track['duration'])

        # Strategy 1: Search with album name for disambiguation
        if album:
            candidates = self._search_candidates(title, album)
            for candidate in candidates:
                score = self._score_candidate(spotify_track, candidate)
                duration_diff = abs(spotify_track['duration'] - candidate['duration'])
                if score >= 65 and duration_diff <= duration_tolerance:
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
                if score >= 65 and duration_diff <= duration_tolerance:
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

        # Strategy 3: Try with primary artist only (when there are featured artists)
        primary_artist, featured = self._extract_featured_artists(artist)
        if featured:  # Only try if there were featured artists
            candidates = self._search_candidates(title, primary_artist)
            for candidate in candidates:
                score = self._score_candidate(spotify_track, candidate)
                duration_diff = abs(spotify_track['duration'] - candidate['duration'])
                if score >= 65 and duration_diff <= duration_tolerance:
                    logger.info(
                        f"Primary artist match (score={score:.1f}): "
                        f"{title} by {artist} "
                        f"-> {candidate['title']} by {candidate['artist']}"
                    )
                    return MatchResult(
                        qobuz_track=candidate,
                        match_type='fuzzy_primary',
                        score=score
                    )

        # Strategy 4: Title search with relaxed artist matching
        # (for cases where artist name differs significantly but is still related)
        candidates = self._search_candidates(title, "")
        for candidate in candidates:
            title_score = self._fuzzy_score(
                self._normalize(title),
                self._normalize(candidate['title'])
            )
            # Must still have SOME artist similarity to prevent wrong covers
            artist_score = self._fuzzy_score(
                self._normalize(artist),
                self._normalize(candidate['artist'])
            )
            duration_diff = abs(spotify_track['duration'] - candidate['duration'])

            # Require: very high title match, reasonable artist match, close duration
            # This prevents matching "Hallelujah" by Jeff Buckley to Leonard Cohen's version
            if title_score >= 92 and artist_score >= 40 and duration_diff <= 3000:
                logger.info(
                    f"Title-focused match (title={title_score:.1f}, artist={artist_score:.1f}): "
                    f"{title} by {artist} "
                    f"-> {candidate['title']} by {candidate['artist']}"
                )
                return MatchResult(
                    qobuz_track=candidate,
                    match_type='fuzzy_title',
                    score=(title_score * 0.7) + (artist_score * 0.3)
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
        Returns combined score only (for backwards compatibility).
        """
        _, _, combined = self._score_candidate_detailed(spotify_track, candidate)
        return combined

    def _score_candidate_detailed(
        self, spotify_track: Dict, candidate: Dict
    ) -> Tuple[float, float, float]:
        """
        Score a candidate track against the Spotify track.
        Returns (title_score, artist_score, combined_score).
        Uses multiple fuzzy algorithms, featured artist matching, and weights.
        """
        spotify_title = self._normalize(spotify_track['title'])
        spotify_artist = self._normalize(spotify_track['artist'])
        candidate_title = self._normalize(candidate['title'])
        candidate_artist = self._normalize(candidate['artist'])

        # Calculate title scores with multiple algorithms
        title_score = self._fuzzy_score(spotify_title, candidate_title)

        # Calculate artist scores - try multiple approaches
        artist_scores = [self._fuzzy_score(spotify_artist, candidate_artist)]

        # Extract and match featured artists separately
        spotify_primary, spotify_featured = self._extract_featured_artists(spotify_track['artist'])
        candidate_primary, candidate_featured = self._extract_featured_artists(candidate['artist'])

        # Primary artist match
        primary_score = self._fuzzy_score(
            self._normalize(spotify_primary),
            self._normalize(candidate_primary)
        )
        artist_scores.append(primary_score)

        # Check if any featured artist matches
        if spotify_featured or candidate_featured:
            all_spotify_artists = [spotify_primary] + spotify_featured
            all_candidate_artists = [candidate_primary] + candidate_featured

            # Check if any artist from one appears in the other
            for s_artist in all_spotify_artists:
                for c_artist in all_candidate_artists:
                    cross_score = self._fuzzy_score(
                        self._normalize(s_artist),
                        self._normalize(c_artist)
                    )
                    if cross_score > 80:
                        artist_scores.append(cross_score)

        # Also check if artist appears in track title (common for features)
        artist_in_title = fuzz.partial_ratio(spotify_artist, candidate_title)
        if artist_in_title > 70:
            artist_scores.append(artist_in_title)

        artist_score = max(artist_scores)

        # Combined score - equal weighting (50/50) for better artist matching
        combined = (title_score * 0.5) + (artist_score * 0.5)

        # Album matching: bonus for same album, penalty for compilations
        spotify_album = self._normalize(spotify_track.get('album', ''))
        candidate_album = self._normalize(candidate.get('album', ''))
        if spotify_album and candidate_album:
            album_score = fuzz.token_sort_ratio(spotify_album, candidate_album)
            if album_score > 85:
                # Strong album match - significant bonus
                combined = min(100, combined + 8)
            elif album_score > 70:
                # Moderate album match
                combined = min(100, combined + 4)
            elif self._is_compilation_album(candidate_album):
                # Penalize compilation albums when Spotify source isn't a compilation
                if not self._is_compilation_album(spotify_album):
                    combined = max(0, combined - 5)

        return title_score, artist_score, combined

    def _is_compilation_album(self, album_name: str) -> bool:
        """Check if album name suggests it's a compilation/greatest hits."""
        compilation_keywords = [
            'greatest hits', 'best of', 'collection', 'anthology',
            'essential', 'ultimate', 'complete', 'definitive',
            'gold', 'platinum', 'legend', 'classics',
            'hits', 'singles', 'compilation', 'various artists',
            'soundtrack', 'ost', 'now that\'s what i call',
        ]
        album_lower = album_name.lower()
        return any(kw in album_lower for kw in compilation_keywords)

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

        # Add phonetic matching if available (helps with spelling variations)
        if HAS_JELLYFISH and s1 and s2:
            try:
                # Soundex comparison (good for names)
                soundex1 = jellyfish.soundex(s1.split()[0]) if s1.split() else ""
                soundex2 = jellyfish.soundex(s2.split()[0]) if s2.split() else ""
                if soundex1 and soundex2 and soundex1 == soundex2:
                    scores.append(85)  # Bonus for phonetic match

                # Metaphone for more accuracy
                meta1 = jellyfish.metaphone(s1)
                meta2 = jellyfish.metaphone(s2)
                if meta1 and meta2:
                    meta_sim = fuzz.ratio(meta1, meta2)
                    if meta_sim > 80:
                        scores.append(meta_sim)
            except Exception:
                pass  # Phonetic matching is optional

        return max(scores)

    # Known duo/group artists that should NOT be split
    KNOWN_DUOS = {
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
        'tony! toni! toné!',
        'three dog night',
    }

    def _extract_featured_artists(self, s: str) -> Tuple[str, List[str]]:
        """
        Extract primary artist and featured artists from artist string.
        Returns (primary_artist, [featured_artists])

        Carefully handles:
        - Actual featured artists: "Drake feat. Rihanna"
        - Duos/groups: "Simon & Garfunkel" (NOT split)
        - Multiple features: "DJ Khaled feat. Drake, Lil Wayne & Rick Ross"
        """
        if not s:
            return s, []

        # Check if this is a known duo/group - don't split
        s_lower = s.lower().strip()
        for duo in self.KNOWN_DUOS:
            if duo in s_lower or s_lower in duo:
                return s, []

        # Only split on explicit featuring keywords, not bare & or ,
        # Pattern: "Primary Artist feat./ft./featuring/with Other Artists"
        feat_match = re.search(
            r'^(.+?)\s+(?:feat\.?|ft\.?|featuring)\s+(.+)$',
            s, re.IGNORECASE
        )

        if feat_match:
            primary = feat_match.group(1).strip()
            others = feat_match.group(2)
            # Split featured artists on , & and (but keep "and" as word boundary)
            featured = [
                a.strip()
                for a in re.split(r'\s*[,&]\s*|\s+and\s+', others, flags=re.IGNORECASE)
                if a.strip()
            ]
            return primary, featured

        # Check for parenthetical featuring: "Song (feat. Artist)"
        paren_match = re.search(
            r'^(.+?)\s*[\(\[](?:feat\.?|ft\.?|featuring)\s+([^\)\]]+)[\)\]]',
            s, re.IGNORECASE
        )
        if paren_match:
            primary = paren_match.group(1).strip()
            others = paren_match.group(2)
            featured = [
                a.strip()
                for a in re.split(r'\s*[,&]\s*|\s+and\s+', others, flags=re.IGNORECASE)
                if a.strip()
            ]
            return primary, featured

        return s, []

    def _get_duration_tolerance(self, duration_ms: int) -> int:
        """
        Get dynamic duration tolerance based on track length.
        Shorter songs need tighter matching, longer songs can be more lenient.
        """
        if duration_ms < 120000:  # < 2 min
            return 3000  # 3 seconds
        elif duration_ms < 240000:  # < 4 min
            return 5000  # 5 seconds
        elif duration_ms < 480000:  # < 8 min
            return 10000  # 10 seconds
        else:  # Long tracks (live, extended)
            return 30000  # 30 seconds

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
