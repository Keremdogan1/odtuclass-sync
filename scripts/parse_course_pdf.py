import sys
import os
import re
import json
import hashlib
from datetime import datetime, timedelta
import fitz  # PyMuPDF

SEMESTER_START = datetime(2026, 9, 28)  # Monday, September 28, 2026

def parse_phys105_pdf(pdf_path):
    doc = fitz.open(pdf_path)
    full_text = "\n".join(page.get_text() for page in doc)
    
    # 1. Course Metadata
    course_name = "[PHYS 105 All Sections] General Physics I"
    course_id = 2300105

    # 2. Extract Chapters
    # Regex matching Chapter X. Title ... Selected problems: ...
    chapter_regex = re.compile(
        r"Chapter\s+(\d+)\.\s*([^\n\r]+)([\s\S]*?)(?=Chapter\s+\d+\.|$)",
        re.IGNORECASE
    )

    chapters = []
    for match in chapter_regex.finditer(full_text):
        chap_num = int(match.group(1))
        chap_title = match.group(2).strip()
        body = match.group(3)

        # Extract selected problems
        problems = []
        prob_match = re.search(r"Selected\s+problems:\s*([^\n\r]+)", body, re.IGNORECASE)
        if prob_match:
            raw_probs = prob_match.group(1).strip()
            # Clean non-digits/commas
            if raw_probs and raw_probs != "—" and raw_probs != "-":
                tokens = re.split(r"[,;]+", raw_probs)
                for t in tokens:
                    t = t.strip()
                    if t.isdigit():
                        problems.append(t)

        # Extract topics
        topics = []
        for line in body.split("\n"):
            line = line.strip()
            if re.match(r"^[•\-\*]?\s*\d+-\d+", line):
                clean_line = re.sub(r"^[•\-\*]?\s*", "", line)
                topics.append(clean_line)

        # Extract coverage notes
        coverage_match = re.search(r"Course\s+coverage:\s*([^\n\r]+)", body, re.IGNORECASE)
        coverage_note = coverage_match.group(1).strip() if coverage_match else ""

        chapters.append({
            "chapter": chap_num,
            "title": chap_title,
            "topics": topics,
            "coverage": coverage_note,
            "problems": problems,
            "rawBody": body.strip()
        })

    # Sort by chapter
    chapters.sort(key=lambda x: x["chapter"])
    return {
        "courseId": course_id,
        "courseName": course_name,
        "chapters": chapters
    }

def generate_section_payloads(parsed_data, output_dir=None):
    course_id = parsed_data["courseId"]
    course_name = parsed_data["courseName"]
    sections = []

    for item in parsed_data["chapters"]:
        week_num = item["chapter"]  # 1 chapter per week
        week_start_dt = SEMESTER_START + timedelta(weeks=week_num - 1)
        week_end_dt = week_start_dt + timedelta(days=6)

        week_start_str = week_start_dt.strftime("%Y-%m-%d")
        week_end_str = week_end_dt.strftime("%Y-%m-%d")
        week_label = f"{week_start_dt.strftime('%B %d')} - {week_end_dt.strftime('%B %d')}"
        clean_title = f"Week {week_num}: {item['title']}"

        # Markdown content for the section
        content_lines = [
            f"### Chapter {item['chapter']}. {item['title']}",
            "",
            f"**Course Coverage:** {item['coverage']}" if item['coverage'] else "",
            "",
            "#### Topics to be covered:"
        ]
        for t in item["topics"]:
            content_lines.append(f"- {t}")
        
        if item["problems"]:
            content_lines.append("")
            content_lines.append(f"**Suggested problems:** {item['chapter']}: {', '.join(item['problems'])}")
        
        section_content = "\n".join(content_lines).strip()
        content_hash = hashlib.sha256(section_content.encode("utf-8")).hexdigest()

        suggested_problems = []
        if item["problems"]:
            suggested_problems.append({
                "section": str(item["chapter"]),
                "title": item["title"],
                "raw": ", ".join(item["problems"]),
                "problems": item["problems"]
            })

        section_obj = {
            "id": f"section:{course_id}:{week_num}",
            "type": "section",
            "courseId": course_id,
            "courseName": course_name,
            "sectionId": week_num,
            "sectionNumber": week_num,
            "title": clean_title,
            "name": week_label,
            "url": "",
            "content": section_content,
            "contentHash": content_hash,
            "weekStart": week_start_str,
            "weekEnd": week_end_str,
            "suggestedProblems": suggested_problems,
            "event": "created"
        }
        sections.append(section_obj)

        if output_dir:
            os.makedirs(output_dir, exist_ok=True)
            out_file = os.path.join(output_dir, f"section-{course_id}-{week_num}.json")
            with open(out_file, "w", encoding="utf-8") as f:
                json.dump(section_obj, f, indent=2, ensure_ascii=False)
            print(f"[OK] Generated pending section: {out_file}")

    return sections

if __name__ == "__main__":
    default_pdf = r"C:\Programming_Folder\Obsidian\Obsidian-Vault\Courses\PHYS105\Recommended Problems.pdf"
    pdf_path = sys.argv[1] if len(sys.argv) > 1 else default_pdf
    
    if not os.path.exists(pdf_path):
        print(f"Error: PDF not found at {pdf_path}")
        sys.exit(1)

    print(f"Parsing course syllabus PDF: {pdf_path}")
    parsed = parse_phys105_pdf(pdf_path)
    print(f"Course: {parsed['courseName']} (ID: {parsed['courseId']})")
    print(f"Total Chapters parsed: {len(parsed['chapters'])}")

    pending_dir = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        ".odtuclass", "pending"
    )
    sections = generate_section_payloads(parsed, pending_dir)
    print(f"Successfully generated {len(sections)} weekly section payloads in {pending_dir}!")
