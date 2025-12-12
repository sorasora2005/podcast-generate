# curl -s \
#     -X POST \
#     "127.0.0.1:50021/audio_query?speaker=1"\
#     --get --data-urlencode text@texts/example_short.txt \
#     > query.json

curl -s \
    -H "Content-Type: application/json" \
    -X POST \
    -d @query.json \
    "127.0.0.1:50021/synthesis?speaker=1" \
    > audio.wav