#!/usr/bin/env python3
# Look up one email's FN in iCloud CardDAV. Never prints the password.
import base64, json, re, ssl, subprocess, sys
import http.client
from pathlib import Path
from urllib.parse import urlparse

def clean_vcard(value):
    return re.sub(r"(?:&#13;)+$", "", value.strip()).strip()

def report_name(body):
    found = re.search(r"\nFN:([^\r\n]+)", body)
    if not found:
        return None
    return clean_vcard(found.group(1))

def email_values(body):
    found = re.findall(r"\n(?:item\d+\.)?EMAIL[^:\r\n]*:([^\r\n]+)", body)
    return [clean_vcard(item).lower() for item in found]

def matched_name(body, email):
    return picked_name(body, email, email_values(body))

def picked_name(body, email, emails):
    if not emails:
        return report_name(body)
    return confirmed_name(body, email, emails)

def confirmed_name(body, email, emails):
    if clean_vcard(email).lower() not in emails:
        return None
    return report_name(body)

def addressbook_query(email):
    # equals misses a value that ends in &#13;. The stripped address is checked again.
    safe = clean_vcard(email).lower()
    return (
        '<?xml version="1.0"?><c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">'
        '<d:prop><c:address-data><c:prop name="FN"/><c:prop name="EMAIL"/></c:address-data></d:prop>'
        f'<c:filter><c:prop-filter name="EMAIL"><c:text-match collation="i;unicode-casemap" match-type="starts-with">{safe}</c:text-match></c:prop-filter></c:filter>'
        "</c:addressbook-query>"
    )

def connection(host):
    if host not in conns:
        conns[host] = http.client.HTTPSConnection(host, context=ssl.create_default_context())
    return conns[host]

def request_path(path):
    if path:
        return path
    return "/"

def req(method, url, body, depth="0"):
    parsed = urlparse(url)
    conn = connection(parsed.netloc)
    conn.request(
        method,
        request_path(parsed.path),
        body=body.encode(),
        headers={"Authorization": auth, "Depth": depth, "Content-Type": "application/xml; charset=utf-8"},
    )
    response = conn.getresponse()
    return response.status, response.read().decode(errors="replace")

def href(xml, tag):
    match = re.search(rf"<[^>]*{tag}[^>]*>\s*<[^>]*href[^>]*>([^<]+)<", xml)
    return match.group(1) if match else None

if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: carddav.py email"}))
        sys.exit(2)

    email = clean_vcard(sys.argv[1]).lower()
    merit = json.loads((Path(__file__).resolve().parent.parent / "site.config.json").read_text())["merit"]
    user = merit["carddavUser"]
    found = subprocess.run(
        ["security", "find-generic-password", "-s", merit["carddavKeychainService"], "-w"],
        capture_output=True,
        text=True,
    )
    if found.returncode != 0 or not found.stdout.strip():
        print(json.dumps({"error": "keychain"}))
        sys.exit(1)
    password = found.stdout.strip()
    auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    conns = {}

    try:
        status, body = req(
            "PROPFIND",
            "https://contacts.icloud.com/",
            '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>',
        )
        principal = href(body, "current-user-principal")
        if status != 207 or not principal:
            print(json.dumps({"error": "principal"}))
            sys.exit(1)
        principal_url = "https://contacts.icloud.com" + principal if principal.startswith("/") else principal
        status, body = req(
            "PROPFIND",
            principal_url,
            '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:prop><c:addressbook-home-set/></d:prop></d:propfind>',
        )
        home = href(body, "addressbook-home-set")
        if not home:
            print(json.dumps({"error": "home"}))
            sys.exit(1)
        if home.startswith("/"):
            home = "https://contacts.icloud.com" + home
        book = home.rstrip("/") + "/card/"
        status, body = req("REPORT", book, addressbook_query(email), "1")
        if status != 207:
            print(json.dumps({"error": "lookup"}))
            sys.exit(1)
        print(json.dumps({"name": matched_name(body, email)}))
    except Exception:
        print(json.dumps({"error": "lookup"}))
        sys.exit(1)
