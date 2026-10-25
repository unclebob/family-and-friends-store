#!/bin/sh
# Stand-in for carddav.py in agent tests: prints $FAKE_CARD_DIR/reply.json and counts its runs.
echo run >> "$FAKE_CARD_DIR/runs"
cat "$FAKE_CARD_DIR/reply.json"
