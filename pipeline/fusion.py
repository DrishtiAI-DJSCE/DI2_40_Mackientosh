"""The policy fusion state machine: from evidence records to a review route.

This is the only place in the codebase permitted to decide what happens to a
person, and it is deliberately incapable of deciding the thing everyone wants
it to decide. There are six states; it can write four of them.

    no_action             nothing reliable was observed
    context_observation   observed, and explained -- paper on a desk, a
                          keyboard, ordinary workstation activity
    needs_better_view     the system could not see well enough to say
    review_candidate      independent signals converged; a human should look
    ------------------------------------------------------------------------
    human_confirmed       a reviewer watched it and confirmed a violation
    human_dismissed       a reviewer watched it and cleared it

The line is real. `route()` raises if asked to produce either of the bottom
two, and nothing else in the pipeline may write them.

### Why `needs_better_view` is a first-class state and not an error

Because the alternative is that every failure -- an occluded hand, a SAM 3
timeout, a head too small to measure -- silently becomes `no_action`, and
`no_action` reads to a reviewer as "this person was fine". Those are opposite
claims. On this corpus the difference is not marginal: 909 of the 1,010 tracks
across four completed runs never resolved a head orientation baseline at all. A
dashboard that folded those into "no signal" would be reporting 909 clean
candidates it never actually looked at.

### What makes a review candidate

Five conditions, all evaluated and all recorded whether they pass or fail. The
spec is: a stable proposal, SAM 3 either supporting it or unable to call it
equipment, association to a specific person's hands, duration or recurrence
past an isolated burst, and no dominant equipment explanation.

Each condition stores the figure that decided it. A card that cannot show its
own arithmetic does not get shown.

### The independence rule still governs escalation

Object evidence and SAM 3 are one modality, not two -- they are both looking at
the same pixels for the same thing. Escalation past a single-modality indicator
requires a second *sensing* modality: head orientation, or presence. This is
inherited from `pipeline/verdict.py` and re-stated here because it is the rule
most likely to be quietly dropped when someone wants more red cards.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from pipeline import reason_codes as rc
from pipeline import verdict as vd

NO_ACTION = "no_action"
CONTEXT_OBSERVATION = "context_observation"
NEEDS_BETTER_VIEW = "needs_better_view"
REVIEW_CANDIDATE = "review_candidate"
HUMAN_CONFIRMED = "human_confirmed"
HUMAN_DISMISSED = "human_dismissed"

MACHINE_STATES = (NO_ACTION, CONTEXT_OBSERVATION, NEEDS_BETTER_VIEW,
                  REVIEW_CANDIDATE)
HUMAN_STATES = (HUMAN_CONFIRMED, HUMAN_DISMISSED)
ALL_STATES = MACHINE_STATES + HUMAN_STATES

# Ordering for "the strongest thing said about this track". Note that
# needs_better_view outranks context_observation: not being able to see is a
# more urgent operational fact than having seen something ordinary.
STATE_ORDER = {NO_ACTION: 0, CONTEXT_OBSERVATION: 1, NEEDS_BETTER_VIEW: 2,
               REVIEW_CANDIDATE: 3, HUMAN_DISMISSED: 4, HUMAN_CONFIRMED: 5}


@dataclass
class Policy:
    """Thresholds, each carrying where its number came from.

    `guard` holds the figures already measured on this corpus and argued in
    `pipeline/verdict.py`; they are not restated here, so there is one place to
    change them.
    """

    guard: vd.Guard = field(default_factory=vd.Guard)

    # measured: the ratio of equipment suppressions to total adjudications
    # separates the two corpus failure modes cleanly. On 04_talking (a computer
    # lab) it is 402/409 = 0.98; on 12_paper it is 48/184 = 0.26. Anything
    # above this floor means the seat's paper-like detections are explained by
    # its hardware, and the object route should not fire.
    equipment_dominance: float = 0.60

    # declared: a single continuous burst is one observation. Two separated
    # episodes are a pattern. Nothing has validated 2 as the right number.
    min_episodes_for_recurrence: int = 2

    # declared: below this share of a person's sightings having a resolvable
    # wrist, object association is guesswork and the track routes to
    # needs_better_view rather than to no_action.
    min_wrist_resolution_rate: float = 0.25

    # Exam policy. Loose paper is prohibited by default because that is the
    # rule in the corpus we have; a hall that issues rough sheets sets this
    # False and paper handling drops to context_observation.
    loose_paper_prohibited: bool = True


@dataclass
class Condition:
    """One clause of the review-candidate test, and the figure that decided it."""

    name: str
    passed: bool
    detail: str


@dataclass
class TrackOutcome:
    """What the machine is willing to say about one person."""

    track_id: int
    seat: str = "unattributed"
    state: str = NO_ACTION

    reason_codes: list = field(default_factory=list)
    conditions: list = field(default_factory=list)
    modalities: list = field(default_factory=list)

    # The per-track funnel. These are the dashboard's operational numbers, and
    # they are counts of proposals, never of "incidents".
    proposals: int = 0
    gated: int = 0
    sam3_supported: int = 0
    sam3_equipment: int = 0
    sam3_not_confirmed: int = 0
    sam3_unavailable: int = 0
    sam3_phone: int = 0

    priority: float = 0.0

    def add(self, code: str) -> None:
        rc.get(code)
        if code not in self.reason_codes:
            self.reason_codes.append(code)

    def why(self) -> list:
        """The reason chain, in reviewer-facing words."""
        return [f"{r.code}: {r.meaning}" for r in
                (rc.get(c) for c in self.reason_codes)]

    def guardrails(self) -> list:
        """What this outcome must not be read as saying. Rendered on the card."""
        return [rc.get(c).guardrail for c in self.reason_codes]


def classify_record(record) -> str:
    """The state one proposal argues for, on its own.

    Precedence is fixed and is the point of the function: an abstention beats
    a negative, and equipment context beats a bare proposal. A record that both
    failed the wrist gate and hit a SAM 3 outage is `needs_better_view`, not
    `no_action`, because we do not know what the outage would have said.
    """
    if record.sam3.is_abstention or record.has(rc.SAM3_UNAVAILABLE.code):
        return NEEDS_BETTER_VIEW
    if record.has(rc.SAM3_PHONE_NAMED.code):
        return REVIEW_CANDIDATE
    if record.has(rc.SAM3_EQUIPMENT_CONTEXT.code):
        return CONTEXT_OBSERVATION
    if record.has(rc.SAM3_SUPPORTED.code):
        return REVIEW_CANDIDATE
    if record.has(rc.SAM3_NOT_CONFIRMED.code):
        # Not confirmed is not false. It is the state of not knowing.
        return NEEDS_BETTER_VIEW
    if record.has(rc.OBJECT_NO_WRIST_RESOLVED.code):
        return NEEDS_BETTER_VIEW
    if record.has(rc.OBJECT_AWAY_FROM_WRIST.code) or \
            record.has(rc.OBJECT_TOO_LARGE.code):
        return NO_ACTION
    return CONTEXT_OBSERVATION


def _object_conditions(outcome, evidence, policy):
    """The five clauses of the review test for object evidence."""
    guard = policy.guard
    episodes = len(evidence.get("episodes") or [])
    longest = float(evidence.get("longest_episode_ms") or 0.0)
    wrist_rate = 0.0
    sightings = float(evidence.get("sightings") or 0.0)
    if sightings:
        wrist_rate = float(evidence.get("wrist_resolved_sightings") or 0.0) / sightings

    adjudicated = (outcome.sam3_supported + outcome.sam3_equipment
                   + outcome.sam3_not_confirmed + outcome.sam3_phone)
    equipment_share = (outcome.sam3_equipment / adjudicated) if adjudicated else 0.0

    stable = outcome.gated > 0 and (episodes > 0 or outcome.sam3_phone > 0)
    outcome.conditions.append(Condition(
        "proposal_survives_geometry", stable,
        f"{outcome.gated} of {outcome.proposals} proposals were at a wrist and "
        f"small enough, across {episodes} episode(s)"))

    verified = (outcome.sam3_phone > 0
                or outcome.sam3_supported >= guard.min_corroborations_indicator
                or adjudicated == 0)
    outcome.conditions.append(Condition(
        "sam3_supports_or_cannot_exclude", verified,
        f"SAM 3 supported {outcome.sam3_supported}, named a phone "
        f"{outcome.sam3_phone}, could not confirm {outcome.sam3_not_confirmed}, "
        f"called equipment {outcome.sam3_equipment}"
        if adjudicated else "not adjudicated by SAM 3"))

    associated = wrist_rate >= policy.min_wrist_resolution_rate
    outcome.conditions.append(Condition(
        "associated_with_this_person", associated,
        f"a wrist resolved in {wrist_rate:.0%} of this person's sightings"))

    # Recurrence needs a floor on total time as well as on episode count.
    # Without it, four separate 250 ms sampler hits -- 1.0 s of handling in
    # total -- satisfy "recurs", which is precisely the isolated burst the
    # clause exists to exclude. Measured: the highest-ranked false positive on
    # 12_paper handled for 5.0 s, so that is the floor either path must clear.
    total = float(evidence.get("total_handling_ms") or 0.0)
    persistent = (longest >= guard.handling_ms_indicator
                  or (episodes >= policy.min_episodes_for_recurrence
                      and total >= guard.handling_ms_indicator))
    outcome.conditions.append(Condition(
        "lasts_or_recurs", persistent,
        f"longest continuous handling {longest / 1000:.1f}s, "
        f"{total / 1000:.1f}s in total across {episodes} episode(s)"))

    unexplained = equipment_share < policy.equipment_dominance
    outcome.conditions.append(Condition(
        "no_dominant_equipment_explanation", unexplained,
        f"{equipment_share:.0%} of adjudicated proposals at this seat were "
        f"named workstation equipment" if adjudicated
        else "no equipment adjudication available"))

    return stable and verified and associated and persistent and unexplained


def route(profile: dict, evidence: dict | None = None,
          records: list | None = None, policy: Policy | None = None
          ) -> TrackOutcome:
    """Fuse one track's evidence into one machine state.

    `profile`  -- a row of `profiles.json`
    `evidence` -- that track's row of `chit_evidence.json`, if any
    `records`  -- that track's `EvidenceRecord`s, if any
    """
    policy = policy or Policy()
    guard = policy.guard
    records = records or []
    evidence = evidence or {}

    out = TrackOutcome(
        track_id=int(profile.get("track_id", -1)),
        seat=str(profile.get("seat_state") or "unattributed"),
    )
    if out.seat == "unattributed":
        out.add(rc.SEAT_UNCALIBRATED.code)

    # --- funnel ---------------------------------------------------------------
    out.proposals = int(evidence.get("raw_detections") or 0) or len(records)
    out.gated = int(evidence.get("kept_detections") or 0)
    for record in records:
        out.sam3_supported += record.has(rc.SAM3_SUPPORTED.code)
        out.sam3_equipment += record.has(rc.SAM3_EQUIPMENT_CONTEXT.code)
        out.sam3_not_confirmed += record.has(rc.SAM3_NOT_CONFIRMED.code)
        out.sam3_unavailable += record.has(rc.SAM3_UNAVAILABLE.code)
        out.sam3_phone += record.has(rc.SAM3_PHONE_NAMED.code)

    # --- observability, evaluated before anything else ------------------------
    coverage = float(profile.get("coverage_of_recording") or 0.0)
    if coverage < guard.min_coverage:
        out.add(rc.TRACK_FRAGMENT.code)
        out.state = NEEDS_BETTER_VIEW
        out.conditions.append(Condition(
            "track_long_enough_to_profile", False,
            f"seen in {coverage:.1%} of the recording"))
        return out

    resolvable = int(profile.get("resolvable_samples") or 0)
    orientation_ok = resolvable >= guard.min_resolvable_samples
    if not orientation_ok:
        out.add(rc.ORIENTATION_NOT_ASSESSABLE.code)

    # Talking is in the operating matrix and is not measurable from this
    # footage. Saying so on every track is what stops a zero appearing in a
    # dashboard panel and being read as "nobody talked".
    out.add(rc.TALKING_NOT_MEASURABLE.code)

    # --- object modality ------------------------------------------------------
    object_indicator = False
    if out.proposals:
        out.add(rc.OBJECT_PROPOSAL_PAPER.code)
        if out.gated:
            out.add(rc.OBJECT_AT_WRIST.code)
        if int(evidence.get("rejected_far_from_hands") or 0):
            out.add(rc.OBJECT_AWAY_FROM_WRIST.code)
        if int(evidence.get("rejected_too_large") or 0):
            out.add(rc.OBJECT_TOO_LARGE.code)
        if int(evidence.get("rejected_no_wrist") or 0):
            out.add(rc.OBJECT_NO_WRIST_RESOLVED.code)

        if out.sam3_phone:
            out.add(rc.SAM3_PHONE_NAMED.code)
        if out.sam3_supported:
            out.add(rc.SAM3_SUPPORTED.code)
        if out.sam3_equipment:
            out.add(rc.SAM3_EQUIPMENT_CONTEXT.code)
        if out.sam3_not_confirmed:
            out.add(rc.SAM3_NOT_CONFIRMED.code)
        if out.sam3_unavailable:
            out.add(rc.SAM3_UNAVAILABLE.code)
        # "No referee ran" is judged on whether any record actually carries a
        # SAM 3 response, not on whether records exist. A run with plenty of
        # proposals and no adjudication is the case this must catch, and
        # checking `not records` silently missed it.
        if not any(r.sam3.attempted for r in records):
            out.add(rc.SAM3_NOT_RUN.code)

        episodes = len(evidence.get("episodes") or [])
        total_ms = float(evidence.get("total_handling_ms") or 0.0)
        if float(evidence.get("longest_episode_ms") or 0.0) >= guard.handling_ms_indicator:
            out.add(rc.OBJECT_HANDLING_SUSTAINED.code)
        if episodes >= policy.min_episodes_for_recurrence \
                and total_ms >= guard.handling_ms_indicator:
            out.add(rc.OBJECT_HANDLING_RECURRENT.code)
        if evidence.get("disposition") == "no_handling_observed" and out.proposals:
            out.add(rc.OBJECT_STATIONARY_ON_DESK.code)

        object_indicator = _object_conditions(out, evidence, policy)
        if object_indicator and not policy.loose_paper_prohibited \
                and not out.sam3_phone:
            out.add(rc.POLICY_MATERIAL_PERMITTED.code)
            object_indicator = False

    # --- orientation modality -------------------------------------------------
    orientation_indicator = False
    if orientation_ok:
        away = float(profile.get("fraction_away_from_baseline") or 0.0)
        if away >= guard.away_fraction_indicator:
            out.add(rc.ORIENTATION_AWAY_SUSTAINED.code)
            orientation_indicator = True
        left = int(profile.get("samples_turned_left") or 0)
        right = int(profile.get("samples_turned_right") or 0)
        if min(left, right) >= guard.repeat_episodes_indicator:
            out.add(rc.ORIENTATION_CHANGE_FREQUENT.code)
        if int(profile.get("samples_looking_down") or 0) > 0:
            out.add(rc.ORIENTATION_DOWN_PROLONGED.code)

    # --- presence modality ----------------------------------------------------
    presence_indicator = False
    if float(profile.get("longest_absence_ms") or 0.0) >= guard.absence_ms_indicator:
        out.add(rc.PRESENCE_GAP.code)
        out.add(rc.TRACK_IDENTITY_UNVERIFIED.code)
        presence_indicator = True

    if int(profile.get("wrist_below_desk_samples") or 0) > 0:
        out.add(rc.HAND_BELOW_DESK_LINE.code)

    # --- state ---------------------------------------------------------------
    out.modalities = sorted(m for m, on in (
        (vd.MODALITY_OBJECT, object_indicator),
        (vd.MODALITY_ORIENTATION, orientation_indicator),
        (vd.MODALITY_PRESENCE, presence_indicator)) if on)

    abstaining = any(rc.get(c).route == rc.R_BETTER_VIEW
                     for c in out.reason_codes
                     if c != rc.TALKING_NOT_MEASURABLE.code)

    # The phone shortcut is conditional on association, not on the naming
    # alone. SAM 3 naming a phone somewhere in a crop says an object exists;
    # it does not say *whose* it is. Routing on the name alone would let a
    # phone visible on a neighbouring desk, or in an invigilator's hand,
    # become evidence against whichever track the crop was cut from.
    associated = next((c.passed for c in out.conditions
                       if c.name == "associated_with_this_person"), False)

    if out.sam3_phone and associated:
        # A phone named by the verifier AND at this person's hands is
        # prohibited outright; there is nothing a second sense could add.
        out.state = REVIEW_CANDIDATE
    elif out.sam3_phone:
        # Named, but not attributable to this person. That is an unresolved
        # question, never a finding either way.
        out.add(rc.OBJECT_NO_WRIST_RESOLVED.code)
        out.state = NEEDS_BETTER_VIEW
    elif object_indicator:
        # All five object conditions passed. Object evidence routes to review
        # on its own -- it is the only modality here that names a *thing*, and
        # the five conditions already encode stability, verification,
        # association, persistence and the equipment explanation.
        #
        # Behaviour signals do not get this. Orientation alone is "turned away
        # from their own baseline", which on this corpus is true of ordinary
        # people looking at their own screens; it needs a second sense before
        # it means anything. Hence the asymmetry below.
        out.state = REVIEW_CANDIDATE
    elif len(out.modalities) >= 2:
        out.state = REVIEW_CANDIDATE
    elif abstaining and not out.modalities:
        out.state = NEEDS_BETTER_VIEW
    elif out.modalities or out.reason_codes:
        out.state = CONTEXT_OBSERVATION
    else:
        out.state = NO_ACTION

    out.priority = (len(out.modalities) * 10.0
                    + out.sam3_phone * 8.0
                    + min(out.sam3_supported, 20) * 0.25
                    + (1.0 if out.state == REVIEW_CANDIDATE else 0.0))
    return out


def assert_machine_state(state: str) -> str:
    """Refuse to let automated code claim a human's verdict."""
    if state in HUMAN_STATES:
        raise ValueError(
            f"{state!r} may only be written by a reviewer through "
            f"EvidenceRecord.add_review(). Automated code cannot confirm or "
            f"dismiss a policy violation.")
    if state not in MACHINE_STATES:
        raise ValueError(f"{state!r} is not a fusion state.")
    return state


def funnel(outcomes: list) -> dict:
    """The proposal-to-review funnel, aggregated. Operational telemetry only.

    These are counts of proposals and tracks. None of them is an accuracy
    figure, and none of them is a count of cheating. Until an independently
    labelled evaluation pack exists, that distinction is the whole difference
    between this being a dashboard and being a lie.
    """
    states = {s: 0 for s in ALL_STATES}
    totals = dict(proposals=0, gated=0, sam3_supported=0, sam3_equipment=0,
                  sam3_not_confirmed=0, sam3_unavailable=0, sam3_phone=0)
    for outcome in outcomes:
        states[outcome.state] += 1
        for key in totals:
            totals[key] += getattr(outcome, key)
    return {"tracks": len(outcomes), "states": states, "proposals": totals,
            "note": "proposal counts are telemetry, not accuracy; no figure "
                    "here is a count of confirmed cheating"}
