#!/usr/bin/env python3
"""Fetch live FPL data for a classic mini-league and regenerate data.json / dashboard.html.

Computes the same statistics that dashboard.js renders (season table, best/worst
gameweek records, manager-of-the-month medals, round win/loss counts) straight
from the official Fantasy Premier League API, so the dashboard no longer depends
on a manually exported .xlsx file.
"""
from __future__ import annotations

import json
import os
import re
import statistics
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests

LEAGUE_ID = os.environ.get("FPL_LEAGUE_ID", "61862")
API_BASE = "https://fantasy.premierleague.com/api"
ROOT = Path(__file__).resolve().parent
DATA_JSON_PATH = ROOT / "data.json"
DASHBOARD_HTML_PATH = ROOT / "dashboard.html"

RECORD_RANK_CUTOFF = 50  # how many distinct point-tiers to keep in best/worst lists
REQUEST_TIMEOUT = 30
HEADERS = {"User-Agent": "fpl-minileague-stats/1.0 (+github actions data sync)"}

# FPL chip codes -> short labels used in the dashboard's "Chipy" column.
# There are 2 of each chip per season (one per half); we only ever show the
# 4 belonging to whichever half is currently in progress.
CHIP_LABELS = {"wildcard": "WC", "freehit": "FH", "bboost": "BB", "3xc": "TC"}


def fetch_json(url: str, params: dict | None = None) -> dict:
    resp = requests.get(url, params=params, timeout=REQUEST_TIMEOUT, headers=HEADERS)
    resp.raise_for_status()
    return resp.json()


def fetch_bootstrap() -> dict:
    return fetch_json(f"{API_BASE}/bootstrap-static/")


def fetch_league_standings(league_id: str) -> tuple[str, list[dict]]:
    entries: list[dict] = []
    league_name = None
    page = 1
    while True:
        data = fetch_json(
            f"{API_BASE}/leagues-classic/{league_id}/standings/",
            params={"page_standings": page},
        )
        if league_name is None:
            league_name = data["league"]["name"]
        results = data["standings"]["results"]
        entries.extend(results)
        if not data["standings"].get("has_next"):
            break
        page += 1
    return league_name, entries


def fetch_entry_history(entry_id: int) -> dict:
    return fetch_json(f"{API_BASE}/entry/{entry_id}/history/")


def fetch_entry_picks(entry_id: int, event_id: int) -> dict:
    """A manager's squad + transfer cost for one gameweek. The 'points' field
    inside this response is NOT live during play (same lag as /history/) —
    we only use this for the picks list (element ids + multipliers) and the
    transfer cost, then compute the live score ourselves from /live/."""
    return fetch_json(f"{API_BASE}/entry/{entry_id}/event/{event_id}/picks/")


def fetch_live_event(event_id: int) -> dict:
    """Per-player live stats (goals, bonus, total_points so far) for one
    gameweek — this endpoint IS updated in near real-time during matches,
    same source FPL's own site uses to show live scores mid-gameweek."""
    return fetch_json(f"{API_BASE}/event/{event_id}/live/")


def build_gw_labels_and_months(
    events: list[dict],
) -> tuple[list[str], list[str | None], list[bool]]:
    """Also returns, per gameweek, whether FPL has finalised it (`data_checked`) —
    i.e. bonus points and prices are locked in, not just that the matches ended."""
    labels, months, data_checked = [], [], []
    for e in sorted(events, key=lambda x: x["id"]):
        labels.append(f"GW {e['id']:02d}")
        deadline = e.get("deadline_time")
        month_name = None
        if deadline:
            dt = datetime.fromisoformat(deadline.replace("Z", "+00:00"))
            month_name = dt.strftime("%B")
        months.append(month_name)
        data_checked.append(bool(e.get("data_checked")))
    return labels, months, data_checked


def current_gw_info(events: list[dict]) -> tuple[int | None, bool, bool]:
    """Which gameweek is 'now' from FPL's own point of view, and its status."""
    current = next((e for e in events if e.get("is_current")), None)
    if current is None:
        current = next((e for e in events if e.get("is_next")), None)
    if current is None and events:
        current = max(events, key=lambda e: e["id"])
    if current is None:
        return None, True, True
    return current["id"], bool(current.get("finished")), bool(current.get("data_checked"))


def competition_ranks(values_desc: list) -> list[int]:
    """Standard competition ranking (1224): ties share a rank, next rank has a gap."""
    ranks = []
    for i, v in enumerate(values_desc):
        if i == 0 or v != values_desc[i - 1]:
            ranks.append(i + 1)
        else:
            ranks.append(ranks[-1])
    return ranks


def season_label_from_events(events: list[dict]) -> str:
    for e in events:
        if e.get("deadline_time"):
            year = datetime.fromisoformat(e["deadline_time"].replace("Z", "+00:00")).year
            return f"{year}/{str(year + 1)[-2:]}"
    return ""


def build_dataset() -> dict:
    bootstrap = fetch_bootstrap()
    events = bootstrap["events"]
    gw_labels, gw_months, gw_data_checked = build_gw_labels_and_months(events)
    num_gw = len(gw_labels)
    season = season_label_from_events(events)
    cur_gw_num, cur_gw_finished, cur_gw_data_checked = current_gw_info(events)

    league_name, standings = fetch_league_standings(LEAGUE_ID)

    # Jedno sdílené stažení živých hráčských bodů pro rozehrané kolo (ne pro
    # každého manažera zvlášť) — použije se níž k dopočtu živého skóre.
    live_points_by_element: dict[int, float] = {}
    if cur_gw_num and not cur_gw_data_checked:
        try:
            live_event = fetch_live_event(cur_gw_num)
            live_points_by_element = {
                el["id"]: el["stats"]["total_points"] for el in live_event.get("elements", [])
            }
        except Exception as exc:
            print(f"  ! živá data pro GW{cur_gw_num} se nepodařilo načíst: {exc}", file=sys.stderr)

    players = []
    all_gw_records = []  # each finished gw score across all managers
    per_gw_scores: dict[int, list[tuple[str, float]]] = {i: [] for i in range(1, num_gw + 1)}
    monthly_totals: dict[str, dict[str, float]] = {}

    for row in standings:
        entry_id = row["entry"]
        name = row["player_name"]
        history = fetch_entry_history(entry_id)

        gws: list[float | None] = [None] * num_gw
        transfer_cost_total = 0
        raw_chips = history.get("chips", [])
        for gw in history["current"]:
            idx = gw["event"] - 1
            if idx >= num_gw:
                continue
            points = float(gw["points"])
            gws[idx] = points
            transfer_cost_total += gw.get("event_transfers_cost", 0)
            per_gw_scores[gw["event"]].append((name, points))
            all_gw_records.append(
                {
                    "points": points,
                    "name": name,
                    "gw": gw_labels[idx],
                    "transfers": gw.get("event_transfers", 0),
                    "closed": gw_data_checked[idx],
                }
            )
            month = gw_months[idx]
            if month:
                monthly_totals.setdefault(month, {})
                monthly_totals[month][name] = monthly_totals[month].get(name, 0) + points

        # /history/ neaktualizuje rozehrané kolo živě (FPL ho tam doplní až po
        # zpracování) a ani "points" v picks endpointu není za běhu kola spolehlivé.
        # Pro AKTUÁLNÍ rozehrané kolo si proto skóre spočítáme sami: vezmeme sestavu
        # (picks) a k ní přičteme živé body hráčů z /event/{gw}/live/, se stejným
        # násobičem jako u kapitána/trojnásobku/bench boostu.
        if cur_gw_num and live_points_by_element:
            idx = cur_gw_num - 1
            try:
                picks_data = fetch_entry_picks(entry_id, cur_gw_num)
            except Exception as exc:
                print(f"  ! sestava pro {name} (GW{cur_gw_num}) se nepodařila načíst: {exc}", file=sys.stderr)
                picks_data = None
            if picks_data:
                live_gross = sum(
                    live_points_by_element.get(pick["element"], 0) * pick.get("multiplier", 0)
                    for pick in picks_data.get("picks", [])
                )
                live_cost = picks_data.get("entry_history", {}).get("event_transfers_cost", 0)
                live_transfers = picks_data.get("entry_history", {}).get("event_transfers", 0)
                live_score = live_gross - live_cost

                old_points = gws[idx]
                old_cost = next(
                    (g.get("event_transfers_cost", 0) for g in history["current"] if g["event"] == cur_gw_num),
                    0,
                )
                if old_points is not None:
                    transfer_cost_total -= old_cost
                    per_gw_scores[cur_gw_num] = [t for t in per_gw_scores[cur_gw_num] if t[0] != name]
                    all_gw_records[:] = [
                        r for r in all_gw_records if not (r["name"] == name and r["gw"] == gw_labels[idx])
                    ]
                    month = gw_months[idx]
                    if month:
                        monthly_totals[month][name] = monthly_totals[month].get(name, 0) - old_points
                gws[idx] = float(live_score)
                transfer_cost_total += live_cost
                per_gw_scores[cur_gw_num].append((name, gws[idx]))
                all_gw_records.append(
                    {
                        "points": gws[idx],
                        "name": name,
                        "gw": gw_labels[idx],
                        "transfers": live_transfers,
                        "closed": gw_data_checked[idx],
                    }
                )
                month = gw_months[idx]
                if month:
                    monthly_totals.setdefault(month, {})
                    monthly_totals[month][name] = monthly_totals[month].get(name, 0) + gws[idx]

        played = [v for v in gws if v is not None]
        # Min a Konzistence smí čerpat jen z kol, která FPL už definitivně uzavřelo
        # (data_checked) — jinak by rozehrané kolo umělo podhodnotit obojí, protože
        # spousta hráčů má zatím 0 bodů (ještě nehráli) a bonusy nejsou finální.
        played_finished = [v for i, v in enumerate(gws) if v is not None and gw_data_checked[i]]
        avg_finished = sum(played_finished) / len(played_finished) if played_finished else None
        total = sum(played)
        half = num_gw // 2

        players.append(
            {
                "name": name,
                "total": total,
                "transfer_cost": transfer_cost_total,
                "avg": round(avg_finished) if avg_finished is not None else None,
                "form5": sum(played[-5:]) if played else 0,
                "sd": round(statistics.pstdev(played), 1) if len(played) > 1 else 0,
                # Konzistence = 100 * (1 - SD / průměr) — vyšší % = stabilnější výkony.
                # Počítáno jen z dokončených kol, ať ji nezkresluje rozehrané kolo.
                "consistency": (
                    round(100 * (1 - statistics.pstdev(played_finished) / avg_finished), 1)
                    if len(played_finished) > 1 and avg_finished
                    else None
                ),
                "max": max(played) if played else None,
                "min": min(played_finished) if played_finished else None,
                "current_gw_points": gws[cur_gw_num - 1] if cur_gw_num else None,
                "half1": sum(v for v in gws[:half] if v is not None),
                "half2": sum(v for v in gws[half:] if v is not None),
                "gws": gws,
                "_raw_chips": raw_chips,
            }
        )

    players.sort(key=lambda p: p["total"], reverse=True)
    for i, p in enumerate(players):
        p["rank"] = i + 1

    # Which half of the season are we currently in? Same GW1..half / half+1..num_gw
    # split already used for half1/half2 above. We look at the last gameweek with
    # any recorded score to know how far the season has actually progressed.
    played_gws = [gw for gw, scores in per_gw_scores.items() if scores]
    current_gw = max(played_gws) if played_gws else 0
    season_half = num_gw // 2
    half_start, half_end = (1, season_half) if current_gw <= season_half else (season_half + 1, num_gw)

    for p in players:
        chips_now: dict[str, int | None] = {label: None for label in CHIP_LABELS.values()}
        for chip in p.pop("_raw_chips"):
            label = CHIP_LABELS.get(chip.get("name"))
            event = chip.get("event")
            if label and event is not None and half_start <= event <= half_end:
                chips_now[label] = event
        p["chips"] = chips_now

    best_sorted = sorted(all_gw_records, key=lambda r: r["points"], reverse=True)
    best_ranks = competition_ranks([r["points"] for r in best_sorted])
    best = [
        {**r, "rank": rk}
        for r, rk in zip(best_sorted, best_ranks)
        if rk <= RECORD_RANK_CUTOFF
    ]

    worst_sorted = sorted(
        (r for r in all_gw_records if r["closed"]), key=lambda r: r["points"]
    )
    worst_ranks = competition_ranks([-r["points"] for r in worst_sorted])
    worst = [
        {**r, "rank": rk}
        for r, rk in zip(worst_sorted, worst_ranks)
        if rk <= RECORD_RANK_CUTOFF
    ]

    winners_count: dict[str, int] = {}
    losers_count: dict[str, int] = {}
    for gw_num, scores in per_gw_scores.items():
        if not scores or not gw_data_checked[gw_num - 1]:
            continue
        max_pts = max(pts for _, pts in scores)
        min_pts = min(pts for _, pts in scores)
        for name, pts in scores:
            if pts == max_pts:
                winners_count[name] = winners_count.get(name, 0) + 1
            if pts == min_pts:
                losers_count[name] = losers_count.get(name, 0) + 1

    def to_ranked_list(counts: dict[str, int]) -> list[dict]:
        items = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
        ranks = competition_ranks([c for _, c in items])
        return [{"rank": rk, "name": name, "count": c} for (name, c), rk in zip(items, ranks)]

    winners = to_ranked_list(winners_count)
    losers = to_ranked_list(losers_count)

    month_order = [m for m in gw_months if m]
    seen_months = []
    for m in month_order:
        if m not in seen_months:
            seen_months.append(m)

    motm = []
    last_closed_month = None
    for month in seen_months:
        totals = monthly_totals.get(month, {})
        if not totals:
            continue
        # Měsíc je "uzavřený" jen když FPL definitivně potvrdilo VŠECHNA jeho kola —
        # jinak by "manažer měsíce" mohl ukazovat někoho, kdo zatím jen vede díky
        # tomu, že mu rozehrané kolo doteď přičetlo víc živých bodů než ostatním.
        month_closed = all(
            gw_data_checked[i] for i, m in enumerate(gw_months) if m == month
        )
        ranked = sorted(totals.items(), key=lambda kv: kv[1], reverse=True)[:3]
        while len(ranked) < 3:
            ranked.append(("—", 0))
        gold, silver, bronze = ranked[0], ranked[1], ranked[2]
        motm.append(
            {
                "month": month,
                "closed": month_closed,
                "gold": {"name": gold[0], "points": gold[1]},
                "silver": {"name": silver[0], "points": silver[1]},
                "bronze": {"name": bronze[0], "points": bronze[1]},
            }
        )
        if month_closed:
            last_closed_month = motm[-1]

    return {
        "league_name": league_name,
        "season": season,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "current_gw": cur_gw_num,
        "current_gw_finished": cur_gw_finished,
        "current_gw_data_checked": cur_gw_data_checked,
        "gw_labels": gw_labels,
        "gw_months": gw_months,
        "players": players,
        "best": best,
        "worst": worst,
        "motm": motm,
        "last_closed_month": last_closed_month,
        "winners": winners,
        "losers": losers,
    }


def inject_into_dashboard(dataset: dict, html_path: Path) -> None:
    html = html_path.read_text(encoding="utf-8")
    payload = json.dumps(dataset, ensure_ascii=False)
    pattern = re.compile(
        r'(<script type="application/json" id="fpl-data">\n).*?(\n</script>)',
        re.DOTALL,
    )
    new_html, count = pattern.subn(lambda m: m.group(1) + payload + m.group(2), html)
    if count == 0:
        print("ERROR: could not find #fpl-data script block in dashboard.html", file=sys.stderr)
        sys.exit(1)
    html_path.write_text(new_html, encoding="utf-8")


def main() -> None:
    dataset = build_dataset()
    DATA_JSON_PATH.write_text(json.dumps(dataset, ensure_ascii=False, indent=2), encoding="utf-8")
    inject_into_dashboard(dataset, DASHBOARD_HTML_PATH)
    print(f"Updated data.json and dashboard.html for {dataset['league_name']} ({dataset['season']}).")


if __name__ == "__main__":
    main()
