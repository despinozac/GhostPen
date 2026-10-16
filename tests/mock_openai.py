import json, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path.endswith("/models"):
            b = json.dumps({"data":[{"id":"zeta"},{"id":"alpha"}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
        else: self.send_response(404); self.end_headers()
    def do_POST(self):
        n = int(self.headers.get("Content-Length",0)); req = json.loads(self.rfile.read(n))
        user = req["messages"][1]["content"]
        text = user if isinstance(user,str) else user[0]["text"]
        think = req.get("think")
        system = req["messages"][0]["content"]
        if "meeting transcripts" in system:
            # The meeting proofread: the numbered lines back, upper-cased, without the speaker.
            import re
            answer = "\n".join("[%s] %s" % (m.group(1), m.group(2).upper()) for m in re.finditer(r"^\[(\d+)\] [^:]*: (.*)$", text, re.M))
        elif "name meeting recordings" in system:
            answer = "Mock meeting"
        elif "for someone with a request about the meeting" in system:
            answer = "- notes for the request"
        elif "You answer a request about a meeting" in system:
            question = text.split("Request: ", 1)[1].split("\n", 1)[0] if "Request: " in text else "?"
            answer = "**Answer** to: " + question
        elif "take notes on one part" in system:
            answer = "- notes on " + text.split("\n", 1)[0]
        elif "You summarize meetings" in system:
            answer = "```markdown\n## Overview\nMock summary of %d characters.\n```" % len(text)
        elif "LEAK" in text and not think: answer = "The user wants me to fix this. <think>x</think>"
        else: answer = "OK: " + text.upper() + (" (thinking)" if think else "")
        if req.get("stream"):
            self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.end_headers()
            for w in answer.split(" "):
                self.wfile.write(("data: " + json.dumps({"choices":[{"delta":{"content": w + " "}}]}) + "\n\n").encode()); self.wfile.flush(); time.sleep(0.05)
            self.wfile.write(b"data: [DONE]\n\n")
        else:
            b = json.dumps({"choices":[{"message":{"content":answer}}]}).encode()
            self.send_response(200); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
