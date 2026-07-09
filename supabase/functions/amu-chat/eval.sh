#!/bin/bash
# ゆげ（amu-chat）の回帰テスト。
# 質問→回答に期待する店名（正規表現・いずれか1つ含めばPASS）を突き合わせる。
# 実行: SUPABASE_ANON_KEY=<anonキー> bash eval.sh
set -u

FN_URL="https://aoehwevqlkpgvzdyfuja.supabase.co/functions/v1/amu-chat"
ANON="${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY を渡してください}"

# 「質問|期待パターン」
CASES=(
  'そば食べたいんだけど、ある？|黒木'
  'ラーメン食べたい|はせ川|NOODLE|夢の途中'
  'タコスある？|タキート|TACO|BESAME|ベサメ'
  'サウナ付きの温泉ある？|寿温泉'
  'ケーキとか甘いもの食べたい|豆|SPICA|プリン'
  'タトゥーあるんだけど入れる温泉は？|竹瓦|駅前高等|不老泉|海門寺|田の湯'
  '朝ごはんどこがいい？|友永|TUMUGU|ツチウム|tsuchiumu'
  'ナチュラルワイン飲みたい|Enfer|EEL|バサラ'
)

pass=0; fail=0
for case in "${CASES[@]}"; do
  q="${case%%|*}"
  expected="${case#*|}"
  body=$(printf '{"messages":[{"role":"user","content":"%s"}]}' "$q")
  reply=$(curl -sN --max-time 60 -X POST "$FN_URL" \
    -H "Authorization: Bearer $ANON" -H "apikey: $ANON" -H 'Content-Type: application/json' \
    -d "$body" | grep -o '"t":"[^"]*"' | sed 's/"t":"//;s/"$//' | tr -d '\n')
  # URLエンコードされたリンク内も見るためデコードして両方で判定
  decoded=$(python3 -c "import sys, urllib.parse; print(urllib.parse.unquote(sys.stdin.read()))" <<<"$reply")
  if grep -qE "$expected" <<<"$decoded"; then
    pass=$((pass+1)); echo "PASS: $q"
  else
    fail=$((fail+1)); echo "FAIL: $q  (期待: $expected)"
    echo "  回答: ${decoded:0:200}"
  fi
done

echo "----"
echo "PASS $pass / FAIL $fail"
[ "$fail" -eq 0 ]
