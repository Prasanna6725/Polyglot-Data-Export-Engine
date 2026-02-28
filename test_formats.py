import requests
import json
import sys
import subprocess
import time

BASE_URL = "http://localhost:8080"

def create_export(format_name):
    """Create an export job and return its ID"""
    payload = {
        "format": format_name,
        "columns": [{"source": "id", "target": "id"}]
    }
    resp = requests.post(f"{BASE_URL}/exports", json=payload)
    if resp.status_code == 201:
        data = resp.json()
        return data["exportId"]
    else:
        print(f"Error creating {format_name} export: {resp.status_code} {resp.text}")
        return None

def download_export(export_id):
    """Download an export and return its content and headers"""
    resp = requests.get(f"{BASE_URL}/exports/{export_id}/download")
    return {
        "status": resp.status_code,
        "content_type": resp.headers.get("Content-Type", "unknown"),
        "content_size": len(resp.text),
        "first_100_chars": resp.text[:100]
    }

def main():
    print("Testing format-specific exports...")
    print()
    
    # Test JSON
    print("=== JSON Export ===")
    json_id = create_export("json")
    if json_id:
        print(f"Created: {json_id}")
        result = download_export(json_id)
        print(f"Content-Type: {result['content_type']}")
        print(f"Size: {result['content_size']} bytes")
        print(f"First 100 chars: {result['first_100_chars']}")
    print()
    
    # Test CSV
    print("=== CSV Export ===")
    csv_id = create_export("csv")
    if csv_id:
        print(f"Created: {csv_id}")
        result = download_export(csv_id)
        print(f"Content-Type: {result['content_type']}")
        print(f"Size: {result['content_size']} bytes")
        print(f"First 100 chars: {result['first_100_chars']}")
    print()
    
    # Test XML
    print("=== XML Export ===")
    xml_id = create_export("xml")
    if xml_id:
        print(f"Created: {xml_id}")
        result = download_export(xml_id)
        print(f"Content-Type: {result['content_type']}")
        print(f"Size: {result['content_size']} bytes")
        print(f"First 100 chars: {result['first_100_chars']}")
    print()
    
    # Check logs
    print("=== Recent Logs ===")
    result = subprocess.run(
        ["docker-compose", "logs", "app", "--tail=30"],
        capture_output=True,
        text=True
    )
    lines = result.stdout.split("\n")
    for line in lines:
        if "Export format" in line or "Export job retrieved" in line:
            print(line)

if __name__ == "__main__":
    main()
