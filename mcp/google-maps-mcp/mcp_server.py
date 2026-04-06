#!/usr/bin/env python3
"""Google Maps MCP Server"""
import os, re, json, time, urllib.parse
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))
import threading, hashlib, base64, secrets
from urllib.parse import urlencode
from datetime import datetime, timezone
import requests
from fastmcp import FastMCP

API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")
TESLA_CLIENT_ID = os.environ.get("TESLA_CLIENT_ID", "")
TESLA_CLIENT_SECRET = os.environ.get("TESLA_CLIENT_SECRET", "")
TESLA_REDIRECT_URI = os.environ.get("TESLA_REDIRECT_URI", "")
TESLA_TOKEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".tesla_token.json")
TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com"
TESLA_AUTH_BASE = "https://auth.tesla.com/oauth2/v3"
REQUEST_TIMEOUT = 15
mcp = FastMCP("Google Maps MCP")

def _headers_routes():
    return {"Content-Type": "application/json", "X-Goog-Api-Key": API_KEY}

def _headers_places():
    return {"Content-Type": "application/json", "X-Goog-Api-Key": API_KEY}

def _nav_urls(lat, lng):
    return {
        "google_maps": f"https://www.google.com/maps/dir/?api=1&destination={lat},{lng}&travelmode=driving",
        "apple_maps": f"https://maps.apple.com/?daddr={lat},{lng}&dirflg=d",
    }

def _format_duration(seconds):
    if seconds < 60: return f"{seconds} 秒"
    minutes = seconds // 60
    if minutes < 60: return f"{minutes} 分鐘"
    hours, remaining = minutes // 60, minutes % 60
    return f"{hours} 小時 {remaining} 分鐘" if remaining else f"{hours} 小時"

def _format_distance(meters):
    return f"{meters} 公尺" if meters < 1000 else f"{meters/1000:.1f} 公里"

def _parse_waypoint(s):
    m = re.match(r"^(-?\d+\.?\d*),\s*(-?\d+\.?\d*)$", s.strip())
    if m:
        return {"location": {"latLng": {"latitude": float(m.group(1)), "longitude": float(m.group(2))}}}
    return {"address": s}

@mcp.tool()
def get_directions(origin: str, destination: str, travel_mode: str = "DRIVE", departure_time: str = "", compute_alternatives: bool = True) -> dict:
    """計算路線，支援即時路況。origin/destination: 座標或地址。travel_mode: DRIVE/TRANSIT/WALK/BICYCLE"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    url = "https://routes.googleapis.com/directions/v2:computeRoutes"
    body = {
        "origin": _parse_waypoint(origin), "destination": _parse_waypoint(destination),
        "travelMode": travel_mode.upper(), "computeAlternativeRoutes": compute_alternatives,
        "routeModifiers": {"avoidTolls": False, "avoidHighways": False},
        "languageCode": "zh-TW", "units": "METRIC",
    }
    field_mask_parts = [
        "routes.duration", "routes.distanceMeters", "routes.description", "routes.warnings",
        "routes.legs.duration", "routes.legs.distanceMeters", "routes.legs.startLocation", "routes.legs.endLocation",
        "routes.legs.steps.navigationInstruction", "routes.legs.steps.distanceMeters",
        "routes.legs.steps.duration", "routes.legs.steps.transitDetails",
        "routes.travelAdvisory", "routes.routeLabels",
    ]
    if travel_mode.upper() == "DRIVE":
        body["routingPreference"] = "TRAFFIC_AWARE_OPTIMAL"
        field_mask_parts.append("routes.staticDuration")
        body["departureTime"] = departure_time if departure_time else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    if travel_mode.upper() == "TRANSIT":
        body["transitPreferences"] = {"routingPreference": "FEWER_TRANSFERS"}
        if departure_time: body["departureTime"] = departure_time
    headers = _headers_routes()
    headers["X-Goog-FieldMask"] = ",".join(field_mask_parts)
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return {"error": f"Routes API 請求失敗: {str(e)}"}
    if "routes" not in data or not data["routes"]:
        return {"error": "找不到路線", "raw": data}
    routes = []
    for i, route in enumerate(data["routes"]):
        duration_sec = int(route.get("duration", "0s").rstrip("s"))
        static_sec = int(route.get("staticDuration", "0s").rstrip("s")) if "staticDuration" in route else None
        distance_m = route.get("distanceMeters", 0)
        route_info = {
            "route_index": i + 1, "duration": _format_duration(duration_sec),
            "duration_seconds": duration_sec, "distance": _format_distance(distance_m),
            "distance_meters": distance_m, "description": route.get("description", ""),
            "labels": route.get("routeLabels", []), "warnings": route.get("warnings", []),
        }
        if static_sec is not None and static_sec > 0:
            route_info["duration_no_traffic"] = _format_duration(static_sec)
            delay = duration_sec - static_sec
            if delay > 60:
                route_info["traffic_delay"] = _format_duration(delay)
                route_info["traffic_status"] = "塞車" if delay > 600 else "略有壅塞"
            else:
                route_info["traffic_status"] = "順暢"
        if travel_mode.upper() == "TRANSIT":
            transit_steps = []
            for leg in route.get("legs", []):
                for step in leg.get("steps", []):
                    td = step.get("transitDetails")
                    if td:
                        transit_steps.append({
                            "line": td.get("transitLine", {}).get("nameShort", td.get("transitLine", {}).get("name", "")),
                            "vehicle_type": td.get("transitLine", {}).get("vehicle", {}).get("type", ""),
                            "departure_stop": td.get("stopDetails", {}).get("departureStop", {}).get("name", ""),
                            "arrival_stop": td.get("stopDetails", {}).get("arrivalStop", {}).get("name", ""),
                            "num_stops": td.get("stopCount", 0),
                            "departure_time": td.get("stopDetails", {}).get("departureTime", ""),
                        })
            if transit_steps: route_info["transit_details"] = transit_steps
        routes.append(route_info)
    dest_coord = data["routes"][0].get("legs", [{}])[-1].get("endLocation", {}).get("latLng", {})
    nav_urls = _nav_urls(dest_coord.get("latitude", 0), dest_coord.get("longitude", 0)) if dest_coord.get("latitude") else {}
    return {"routes": routes, "recommended": routes[0] if routes else None, "navigation_urls": nav_urls}

@mcp.tool()
def resolve_maps_url(maps_url: str) -> dict:
    """解析 Google Maps 短網址或長網址，取得地點完整資訊。"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    try:
        resp = requests.head(maps_url, allow_redirects=True, timeout=REQUEST_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
        full_url = resp.url
    except:
        try:
            resp = requests.get(maps_url, allow_redirects=True, timeout=REQUEST_TIMEOUT, headers={"User-Agent": "Mozilla/5.0"})
            full_url = resp.url
        except requests.RequestException as e:
            return {"error": f"無法解析 URL: {str(e)}"}
    result = {"original_url": maps_url, "resolved_url": full_url}
    place_id, lat, lng = None, None, None
    pid_match = re.search(r"place_id[=:]([A-Za-z0-9_-]+)", full_url)
    if pid_match: place_id = pid_match.group(1)
    coord_match = re.search(r"@(-?\d+\.?\d+),(-?\d+\.?\d+)", full_url)
    if coord_match: lat, lng = float(coord_match.group(1)), float(coord_match.group(2))
    if not coord_match:
        coord_match2 = re.search(r"!3d(-?\d+\.?\d+)!4d(-?\d+\.?\d+)", full_url)
        if coord_match2: lat, lng = float(coord_match2.group(1)), float(coord_match2.group(2))
    query_match = re.search(r"/place/([^/]+)", full_url)
    search_query = urllib.parse.unquote_plus(query_match.group(1)) if query_match else None
    if lat and lng: result["coordinates"] = {"latitude": lat, "longitude": lng}
    if search_query or (lat and lng):
        place_data = _search_place_internal(search_query, lat, lng)
        if place_data: result.update(place_data)
    if place_id: result["place_id"] = place_id
    return result

def _search_place_internal(query=None, lat=None, lng=None):
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = _headers_places()
    headers["X-Goog-FieldMask"] = "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.reviews,places.currentOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.id,places.types"
    body = {"languageCode": "zh-TW", "maxResultCount": 1}
    if query: body["textQuery"] = query
    elif lat and lng: body["textQuery"] = f"{lat},{lng}"
    if lat and lng:
        body["locationBias"] = {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": 500.0}}
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except: return {}
    places = data.get("places", [])
    if not places: return {}
    p = places[0]
    result = {"name": p.get("displayName", {}).get("text", ""), "address": p.get("formattedAddress", ""), "place_id": p.get("id", ""), "types": p.get("types", [])}
    loc = p.get("location", {})
    if loc:
        result["coordinates"] = {"latitude": loc.get("latitude"), "longitude": loc.get("longitude")}
        result["navigation_urls"] = _nav_urls(loc["latitude"], loc["longitude"])
    if "rating" in p:
        result["rating"] = p["rating"]
        result["rating_count"] = p.get("userRatingCount", 0)
    if "nationalPhoneNumber" in p: result["phone"] = p["nationalPhoneNumber"]
    if "websiteUri" in p: result["website"] = p["websiteUri"]
    reviews = p.get("reviews", [])
    if reviews:
        result["reviews"] = [{"rating": r.get("rating"), "text": r.get("text", {}).get("text", ""), "time": r.get("publishTime", ""), "author": r.get("authorAttribution", {}).get("displayName", "")} for r in reviews[:5]]
    hours = p.get("currentOpeningHours", {})
    if hours:
        result["opening_hours"] = hours.get("weekdayDescriptions", [])
        result["open_now"] = hours.get("openNow")
    return result

@mcp.tool()
def search_places(query: str, lat: float = 0.0, lng: float = 0.0, radius: float = 5000.0, max_results: int = 5) -> dict:
    """搜尋地點，回傳星等、評論、營業時間等。"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    url = "https://places.googleapis.com/v1/places:searchText"
    headers = _headers_places()
    headers["X-Goog-FieldMask"] = "places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.reviews,places.currentOpeningHours,places.nationalPhoneNumber,places.websiteUri,places.id,places.types,places.priceLevel"
    body = {"textQuery": query, "languageCode": "zh-TW", "maxResultCount": min(max(max_results, 1), 10)}
    if lat != 0.0 and lng != 0.0:
        body["locationBias"] = {"circle": {"center": {"latitude": lat, "longitude": lng}, "radius": radius}}
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return {"error": f"Places API 請求失敗: {str(e)}"}
    results = []
    for p in data.get("places", []):
        loc = p.get("location", {})
        info = {"name": p.get("displayName", {}).get("text", ""), "address": p.get("formattedAddress", ""), "place_id": p.get("id", ""), "types": p.get("types", [])}
        if loc:
            info["coordinates"] = {"latitude": loc.get("latitude"), "longitude": loc.get("longitude")}
            info["navigation_urls"] = _nav_urls(loc["latitude"], loc["longitude"])
        if "rating" in p: info["rating"] = p["rating"]; info["rating_count"] = p.get("userRatingCount", 0)
        if "priceLevel" in p: info["price_level"] = p["priceLevel"]
        if "nationalPhoneNumber" in p: info["phone"] = p["nationalPhoneNumber"]
        if "websiteUri" in p: info["website"] = p["websiteUri"]
        reviews = p.get("reviews", [])
        if reviews:
            info["reviews"] = [{"rating": r.get("rating"), "text": r.get("text", {}).get("text", ""), "author": r.get("authorAttribution", {}).get("displayName", "")} for r in reviews[:5]]
        hours = p.get("currentOpeningHours", {})
        if hours: info["opening_hours"] = hours.get("weekdayDescriptions", []); info["open_now"] = hours.get("openNow")
        results.append(info)
    return {"query": query, "count": len(results), "places": results}

@mcp.tool()
def optimize_route(waypoints: list[str], start: str, end: str = "") -> dict:
    """多點路線最佳化排序。waypoints: 中途點列表, start: 起點, end: 終點（空=不回起點）"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    url = "https://routes.googleapis.com/directions/v2:computeRoutes"
    body = {
        "origin": _parse_waypoint(start), "destination": _parse_waypoint(end if end else start),
        "intermediates": [_parse_waypoint(wp) for wp in waypoints],
        "travelMode": "DRIVE", "routingPreference": "TRAFFIC_AWARE_OPTIMAL",
        "optimizeWaypointOrder": True,
        "departureTime": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "languageCode": "zh-TW", "units": "METRIC",
    }
    headers = _headers_routes()
    headers["X-Goog-FieldMask"] = "routes.duration,routes.distanceMeters,routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.legs.distanceMeters,routes.staticDuration"
    try:
        resp = requests.post(url, json=body, headers=headers, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return {"error": f"Routes API 請求失敗: {str(e)}"}
    if "routes" not in data or not data["routes"]: return {"error": "無法計算最佳路線", "raw": data}
    route = data["routes"][0]
    optimized_order = route.get("optimizedIntermediateWaypointIndex", list(range(len(waypoints))))
    total_sec = int(route.get("duration", "0s").rstrip("s"))
    total_m = route.get("distanceMeters", 0)
    legs = []
    labels = [start] + [waypoints[i] for i in optimized_order] + [end if end else start]
    for j, leg in enumerate(route.get("legs", [])):
        leg_sec = int(leg.get("duration", "0s").rstrip("s"))
        leg_m = leg.get("distanceMeters", 0)
        legs.append({"segment": f"{labels[j]} → {labels[j+1]}", "duration": _format_duration(leg_sec), "distance": _format_distance(leg_m)})
    return {"optimized_order": [waypoints[i] for i in optimized_order], "total_duration": _format_duration(total_sec), "total_distance": _format_distance(total_m), "legs": legs}

@mcp.tool()
def validate_address(address: str) -> dict:
    """驗證地址是否正確，回傳標準化地址和座標。"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    url = f"https://addressvalidation.googleapis.com/v1:validateAddress?key={API_KEY}"
    body = {"address": {"addressLines": [address], "regionCode": "TW", "languageCode": "zh-TW"}}
    try:
        resp = requests.post(url, json=body, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return {"error": f"Address Validation API 請求失敗: {str(e)}"}
    r = data.get("result", {})
    v, a, g = r.get("verdict", {}), r.get("address", {}), r.get("geocode", {})
    loc = g.get("location", {})
    return {
        "input_address": address, "formatted_address": a.get("formattedAddress", ""),
        "validation_granularity": v.get("validationGranularity", ""),
        "address_complete": v.get("addressComplete", False),
        "coordinates": {"latitude": loc.get("latitude"), "longitude": loc.get("longitude")} if loc else None,
        "place_id": g.get("placeId", ""),
    }

@mcp.tool()
def get_weather(lat: float, lng: float) -> dict:
    """取得指定位置的天氣（目前+未來預報）。"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    result = {}
    url_c = f"https://weather.googleapis.com/v1/currentConditions:lookup?key={API_KEY}"
    try:
        resp = requests.post(url_c, json={"location": {"latitude": lat, "longitude": lng}, "languageCode": "zh-TW", "unitsSystem": "METRIC"}, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        c = resp.json()
        result["current"] = {
            "temperature_c": c.get("temperature", {}).get("degrees"),
            "feels_like_c": c.get("feelsLikeTemperature", {}).get("degrees"),
            "humidity_percent": c.get("humidity", {}).get("percent"),
            "description": c.get("weatherCondition", {}).get("description", {}).get("text", ""),
            "wind_speed_kmh": c.get("wind", {}).get("speed", {}).get("value"),
            "uv_index": c.get("uvIndex"),
        }
    except requests.RequestException as e:
        result["current_error"] = str(e)
    url_f = f"https://weather.googleapis.com/v1/forecast/hours?key={API_KEY}"
    try:
        resp = requests.post(url_f, json={"location": {"latitude": lat, "longitude": lng}, "languageCode": "zh-TW", "unitsSystem": "METRIC", "hours": 12}, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        forecasts = data.get("forecastHours", data.get("hourlyForecasts", []))
        result["forecast"] = [{"time": f.get("forecastTime", ""), "temperature_c": f.get("temperature", {}).get("degrees"), "precipitation_probability": f.get("precipitation", {}).get("probability", {}).get("percent"), "description": f.get("weatherCondition", {}).get("description", {}).get("text", "")} for f in (forecasts[:6] if isinstance(forecasts, list) else [])]
    except requests.RequestException as e:
        result["forecast_error"] = str(e)
    return result

@mcp.tool()
def get_air_quality(lat: float, lng: float) -> dict:
    """取得指定位置的空氣品質。"""
    if not API_KEY: return {"error": "GOOGLE_MAPS_API_KEY 未設定"}
    url = f"https://airquality.googleapis.com/v1/currentConditions:lookup?key={API_KEY}"
    try:
        resp = requests.post(url, json={"location": {"latitude": lat, "longitude": lng}, "languageCode": "zh-TW", "extraComputations": ["HEALTH_RECOMMENDATIONS", "DOMINANT_POLLUTANT_CONCENTRATION"]}, timeout=REQUEST_TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
    except requests.RequestException as e:
        return {"error": f"Air Quality API 請求失敗: {str(e)}"}
    indexes = data.get("indexes", [])
    main_index = indexes[0] if indexes else {}
    pollutants = [{"code": p.get("code", ""), "display_name": p.get("displayName", ""), "concentration": p.get("concentration", {}).get("value")} for p in data.get("pollutants", [])[:5]]
    health_recs = data.get("healthRecommendations", {})
    return {
        "aqi": main_index.get("aqi"), "category": main_index.get("category", ""),
        "dominant_pollutant": main_index.get("dominantPollutant", ""),
        "pollutants": pollutants,
        "health_recommendations": {"general": health_recs.get("generalPopulation", ""), "elderly": health_recs.get("elderly", "")} if health_recs else {},
    }

# ═══ Tesla Token Management ═══

def _load_tesla_token():
    try:
        with open(TESLA_TOKEN_FILE, "r") as f:
            return json.load(f)
    except:
        return None

def _save_tesla_token(token_data):
    with open(TESLA_TOKEN_FILE, "w") as f:
        json.dump(token_data, f)

def _refresh_tesla_token():
    token = _load_tesla_token()
    if not token or "refresh_token" not in token:
        return None
    resp = requests.post(f"{TESLA_AUTH_BASE}/token", data={
        "grant_type": "refresh_token",
        "client_id": TESLA_CLIENT_ID,
        "refresh_token": token["refresh_token"],
    }, timeout=15)
    if resp.status_code == 200:
        new_token = resp.json()
        if "refresh_token" not in new_token:
            new_token["refresh_token"] = token["refresh_token"]
        _save_tesla_token(new_token)
        return new_token
    return None

def _tesla_api_get(path):
    token = _load_tesla_token()
    if not token or "access_token" not in token:
        return {"error": "Tesla 未授權。請先執行 tesla_auth_url 取得授權連結。"}
    headers = {"Authorization": f"Bearer {token['access_token']}", "Content-Type": "application/json"}
    resp = requests.get(f"{TESLA_API_BASE}{path}", headers=headers, timeout=15)
    if resp.status_code == 401:
        new_token = _refresh_tesla_token()
        if new_token:
            headers["Authorization"] = f"Bearer {new_token['access_token']}"
            resp = requests.get(f"{TESLA_API_BASE}{path}", headers=headers, timeout=15)
        else:
            return {"error": "Tesla token 已過期，請重新授權。"}
    return resp.json()

# ═══ Tool: tesla_auth_url ═══

@mcp.tool()
def tesla_auth_url() -> dict:
    """產生 Tesla OAuth 授權連結。在瀏覽器開啟此連結完成授權。"""
    if not TESLA_CLIENT_ID:
        return {"error": "TESLA_CLIENT_ID 未設定"}
    state = secrets.token_urlsafe(16)
    code_verifier = secrets.token_urlsafe(32)
    code_challenge = base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
    _save_tesla_token({"code_verifier": code_verifier, "state": state})
    params = {
        "response_type": "code",
        "client_id": TESLA_CLIENT_ID,
        "redirect_uri": TESLA_REDIRECT_URI,
        "scope": "openid vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds",
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return {"auth_url": f"{TESLA_AUTH_BASE}/authorize?{urlencode(params)}", "instruction": "請在瀏覽器開啟此連結，登入 Tesla 帳號並授權。"}

# ═══ Tool: get_vehicle_status ═══

@mcp.tool()
def get_vehicle_status() -> dict:
    """取得 Tesla 車輛即時狀態（電量、位置、充電狀態等）。"""
    if not TESLA_CLIENT_ID:
        return {"error": "TESLA_CLIENT_ID 未設定"}
    token = _load_tesla_token()
    if not token or "access_token" not in token:
        return {"error": "Tesla 未授權。請先執行 tesla_auth_url 取得授權連結。"}
    vehicles = _tesla_api_get("/api/1/vehicles")
    if "error" in vehicles:
        return vehicles
    vehicle_list = vehicles.get("response", [])
    if not vehicle_list:
        return {"error": "找不到任何車輛"}
    vehicle = vehicle_list[0]
    vehicle_id = vehicle.get("id")
    result = {"vehicle_name": vehicle.get("display_name", ""), "vin": vehicle.get("vin", ""), "state": vehicle.get("state", "")}
    if vehicle.get("state") == "online":
        data = _tesla_api_get(f"/api/1/vehicles/{vehicle_id}/vehicle_data?endpoints=charge_state%3Blocation_data%3Bvehicle_state%3Bclimate_state")
        if "response" in data:
            resp = data["response"]
            charge = resp.get("charge_state", {})
            if charge:
                result["battery"] = {"level_percent": charge.get("battery_level"), "range_km": round(charge.get("battery_range", 0) * 1.60934, 1), "charging_state": charge.get("charging_state"), "charge_limit_percent": charge.get("charge_limit_soc"), "minutes_to_full": charge.get("minutes_to_full_charge"), "charger_power_kw": charge.get("charger_power")}
            drive = resp.get("drive_state", resp.get("location_data", {}))
            if drive:
                result["location"] = {"latitude": drive.get("latitude"), "longitude": drive.get("longitude"), "heading": drive.get("heading"), "speed_kmh": drive.get("speed")}
            vs = resp.get("vehicle_state", {})
            if vs:
                result["vehicle"] = {"odometer_km": round(vs.get("odometer", 0) * 1.60934, 1), "locked": vs.get("locked"), "sentry_mode": vs.get("sentry_mode")}
            climate = resp.get("climate_state", {})
            if climate:
                result["climate"] = {"inside_temp_c": climate.get("inside_temp"), "outside_temp_c": climate.get("outside_temp"), "climate_on": climate.get("is_climate_on")}
    else:
        result["note"] = "車輛處於休眠狀態，無法取得即時資料。"
    return result

# ═══ Tool: get_ev_route ═══

@mcp.tool()
def get_ev_route(destination: str, origin: str = "") -> dict:
    """結合 Tesla 電量與 Routes API，計算路線並預估抵達剩餘電量。destination: 目的地。origin: 起點（空=車輛位置）。"""
    vehicle = get_vehicle_status()
    if "error" in vehicle:
        return vehicle
    battery = vehicle.get("battery", {})
    battery_level = battery.get("level_percent")
    range_km = battery.get("range_km")
    if battery_level is None:
        return {"error": "無法取得電量（車輛可能休眠）"}
    if not origin:
        loc = vehicle.get("location", {})
        if loc and loc.get("latitude"):
            origin = f"{loc['latitude']},{loc['longitude']}"
        else:
            return {"error": "無法取得車輛位置，請手動提供起點"}
    route = get_directions(origin=origin, destination=destination, travel_mode="DRIVE")
    if "error" in route:
        return route
    recommended = route.get("recommended", {})
    distance_km = recommended.get("distance_meters", 0) / 1000
    if range_km and range_km > 0:
        consumption_pct = (distance_km / range_km) * battery_level
    else:
        consumption_pct = distance_km * 0.15
    remaining_pct = battery_level - consumption_pct
    result = {"vehicle_name": vehicle.get("vehicle_name", ""), "current_battery_percent": battery_level, "current_range_km": range_km, "route": {"distance": recommended.get("distance", ""), "duration": recommended.get("duration", ""), "traffic_status": recommended.get("traffic_status", "")}, "battery_estimate": {"estimated_consumption_percent": round(consumption_pct, 1), "estimated_remaining_percent": round(remaining_pct, 1), "sufficient": remaining_pct > 10}, "navigation_urls": route.get("navigation_urls", {})}
    if remaining_pct <= 10:
        result["warning"] = f"電量可能不足！預估抵達剩餘 {round(remaining_pct, 1)}%，建議中途充電。"
    return result

# ═══ OAuth Callback ═══

from starlette.responses import HTMLResponse, Response
from starlette.requests import Request

TESLA_PUBLIC_KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "com.tesla.3p.public-key.pem")

@mcp.custom_route("/.well-known/appspecific/com.tesla.3p.public-key.pem", methods=["GET"])
async def tesla_public_key(request: Request):
    try:
        with open(TESLA_PUBLIC_KEY_FILE, "r") as f:
            content = f.read()
        return Response(content, media_type="application/x-pem-file")
    except FileNotFoundError:
        return Response("Not Found", status_code=404)

@mcp.custom_route("/oauth/callback", methods=["GET"])
async def oauth_callback(request: Request):
    code = request.query_params.get("code")
    if not code:
        return HTMLResponse("<h1>❌ 授權失敗</h1>")
    saved = _load_tesla_token()
    code_verifier = saved.get("code_verifier", "") if saved else ""
    token_resp = requests.post(f"{TESLA_AUTH_BASE}/token", data={"grant_type": "authorization_code", "client_id": TESLA_CLIENT_ID, "client_secret": TESLA_CLIENT_SECRET, "code": code, "redirect_uri": TESLA_REDIRECT_URI, "code_verifier": code_verifier, "audience": TESLA_API_BASE}, timeout=15)
    if token_resp.status_code == 200:
        _save_tesla_token(token_resp.json())
        return HTMLResponse("<h1>✅ Tesla 授權成功！</h1><p>可以關閉此頁面，回到 Claude 使用。</p>")
    return HTMLResponse(f"<h1>❌ 失敗</h1><p>{token_resp.status_code}: {token_resp.text}</p>")

if __name__ == "__main__":
    mcp.run(transport="sse", port=8002)
