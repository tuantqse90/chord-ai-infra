import { describe, expect, it } from "bun:test";
import { avatarUrl, buildQuery, capPerAuthor, cleanPost, decodeEntities, engagementFloor, inWindow, isSpam, mediaOf, meetsFloor, normalizeQuery, postScore, TEXT_CAP, topTerms, velocity } from "./xSearch";

const raw = (text: string, followers = 5000, extra: Record<string, unknown> = {}) => ({
  id: "1", url: "https://x.com/a/status/1", text, createdAt: "Thu Sep 25 12:00:00 +0000 2026", likeCount: 10, retweetCount: 2, replyCount: 1, quoteCount: 0, viewCount: 900,
  author: { userName: "a", name: "A", followers, isBlueVerified: true }, ...extra,
});

describe("xSearch — cleaning and spam (first $SUI 'Top' result live was a giveaway)", () => {
  it("drops giveaways, address bait, like+RT, shill lists, bots and tiny accounts", () => {
    const spam = [
      "Here We go 🎉 Comment your $SUI address. Like + RT for better chances",
      "Drop your wallet below for the airdrop",
      "$SUI $APT $SEI $TIA $INJ $JUP next 100x",
      "Giveaway time! RT & follow",
    ];
    for (const t of spam) expect(isSpam(cleanPost(raw(t)))).toBe(true);
    expect(isSpam(cleanPost(raw("SUI breaking out of the 3-month range on volume", 20)))).toBe(true);
    expect(isSpam(cleanPost(raw("real post", 5000)), { author: { isAutomated: true } })).toBe(true);
    expect(isSpam(cleanPost(raw("SUI breaking out of the 3-month range on volume")))).toBe(false);
  });
  it("cleans text, ISO time and the author", () => {
    const p = cleanPost(raw("gm  https://t.co/abc123 wagmi"));
    expect(p.text).toBe("gm wagmi");
    expect(p.createdAt).toBe("2026-09-25T12:00:00.000Z");
    expect(p.author).toEqual({ userName: "a", name: "A", followers: 5000, verified: true, avatar: null });
    expect(postScore(p)).toBeGreaterThan(10 + 4 + 1.5);
  });
  // Owner screenshot 2026-10-04: "$SOL OR Solana (KOL OR alpha …" top 24h came back as eight rows of claim bait, four from
  // one account, with "&amp;" printed in the text. The texts below are those rows as X sends them (HTML-escaped).
  it("drops the claim bait from the 04/10 screenshot, keeps airdrop news", () => {
    const bait = [
      "this is massive. 10.10.26 Drop your $SOL address",
      "CLAIM 700,000 $MONA STEP 1: 💜 &amp; 🔄 + follow",
      "🚀 The $MONA airdrop is live! Ready to claim your share?",
      "0.65 $SOL Just hit the like and drop your wallets",
      "$MARS AIRDROP $100K REWARD POOL 🎁 ✅ Follow",
      "Just drop your $SOL address Follow &amp; RT 🔄",
      "STEP 1: 💜 &amp; 🔄 this post",
      // the 20 posts X returned for that search on 04/10, the ones the first version of the filter kept
      "Zero plans. Zero fear. Just $ZeroCat Launch at 4pm UTC Send $sol address, first 100 wallets",
      "Yesterday I sent $100 to 7 people 🎉 Today I will send $100 to 10 more new people 🔥 What’s your #Stake username or $SOL wallet address 👇",
      "Drop $SOL addresses Check your wallet later 🐼",
      "Every wallet receives 150,000 $MONA 🪂 Drop your Solana $Sol Address and RT ♻️",
      "CLAIM 200,000 $MONA STEP 1 : 💟 &amp; 🔁 + Follow 🔔 STEP 2 : Drop your #Solana address First 333 $SOL Address",
      "Can I get a GM? ❤️ Drop your $SOL addy",
      "Each wallet will receive 200,000 $MONA🪂 Leave your $SOL address and repost ♻️",
      "I will give you $10 worth of $sol and a job! Get in now and drop $sol addy!",
    ];
    for (const t of bait) expect([t, isSpam(cleanPost(raw(t)))]).toEqual([t, true]);
    const real = [
      "The Jupiter airdrop is live, 700M JUP unlocked over the next 24h — watch sell pressure on the open",
      "Never share your wallet seed phrase, and don't leave your ETH on an exchange you can't name",
      "Step 1: bridge USDC to Base. Step 2: there is no step 2",
      "SOL funding flipped negative & OI is up 12% — shorts are paying",
      "A sharp drop in active wallets on Solana this week, the first since July",
      "The SEC declined to comment on the address that moved 40k ETH",
      "If you send SOL to address poisoning lookalikes it is gone — check the first and last 6 characters",
    ];
    for (const t of real) expect([t, isSpam(cleanPost(raw(t)))]).toEqual([t, false]);
  });
  it("decodes the entities X escapes, once", () => {
    expect(cleanPost(raw("3x up on $PHONE CA&gt;&gt; abc &amp; more &#39;soon&#39; &#x1F680;")).text).toBe("3x up on $PHONE CA>> abc & more 'soon' 🚀");
    expect(decodeEntities("&amp;lt; stays escaped once")).toBe("&lt; stays escaped once");
    expect(decodeEntities("&bogus; &#0; &#xD800;")).toBe("&bogus; &#0; &#xD800;");
  });
  it("avatar: X's image hosts over https only, 96 px", () => {
    expect(avatarUrl("https://pbs.twimg.com/profile_images/2074253560053747714/a5H9wLG1_normal.jpg")).toBe("https://pbs.twimg.com/profile_images/2074253560053747714/a5H9wLG1_x96.jpg");
    expect(avatarUrl("https://abs.twimg.com/sticky/default_profile_images/default_profile_normal.png")).toBe("https://abs.twimg.com/sticky/default_profile_images/default_profile_x96.png");
    for (const bad of ["http://pbs.twimg.com/a_normal.jpg", "https://evil.example/pbs.twimg.com/a.jpg", "https://pbs.twimg.com.evil.example/a.jpg", "javascript:alert(1)", "", null, 7]) expect(avatarUrl(bad)).toBeNull();
    expect(cleanPost(raw("gm", 5000, { author: { userName: "a", name: "A &amp; B", followers: 9, profilePicture: "https://pbs.twimg.com/profile_images/1/x_normal.png" } })).author).toEqual({ userName: "a", name: "A & B", followers: 9, verified: false, avatar: "https://pbs.twimg.com/profile_images/1/x_x96.png" });
  });
  it("two posts per account, order kept", () => {
    const by = (u: string, id: number) => ({ id, author: { userName: u } });
    expect(capPerAuthor([by("Mona", 1), by("mona", 2), by("sigma", 3), by("MONA", 4), by("sigma", 5), by("sigma", 6), by("solo", 7)]).map((p) => p.id)).toEqual([1, 2, 3, 5, 7]);
  });
  // Live 2026-10-04: `$SOL staking OR ETF OR ETFs since_time:…` returned posts 16 days old under "top 24h" — X applied the
  // window to the last alternative only.
  it("the time window covers every alternative of an OR query", () => {
    // board #128: the subject is ANDed with the alternatives, so no top-level OR is left to bracket
    expect(buildQuery("$SOL staking OR ETF OR ETFs", 1791000000)).toBe("$SOL (staking OR ETF OR ETFs) since_time:1791000000 -filter:replies");
    expect(buildQuery("$SOL OR Solana", 1791000000)).toBe("($SOL OR Solana) since_time:1791000000 -filter:replies");
    expect(buildQuery("  $SOL funding ", 1791000000)).toBe("$SOL funding since_time:1791000000 -filter:replies");
    expect(buildQuery("from:aeyakovenko", 1791000000, true)).toBe("from:aeyakovenko since_time:1791000000");
    expect(buildQuery("COLORADO fork", 5)).toBe("COLORADO fork since_time:5 -filter:replies"); // "OR" inside a word is not the operator
    const since = Date.parse("2026-10-03T05:00:00Z") / 1000;
    expect(inWindow({ createdAt: "2026-10-03T05:00:00.000Z" }, since)).toBe(true);
    expect(inWindow({ createdAt: "2026-10-04T01:00:00.000Z" }, since)).toBe(true);
    expect(inWindow({ createdAt: "2026-09-18T02:42:00.000Z" }, since)).toBe(false);
    expect(inWindow({ createdAt: "" }, since)).toBe(true);
  });
  // Board #128 (live 04/10): `$SOL staking OR ETF OR ETFs` → X read ($SOL staking) OR ETF OR ETFs → NEAR / PEPE / real-estate ETF posts.
  it("OR queries keep their subject: `$SOL staking OR ETF` → `$SOL (staking OR ETF)`", () => {
    expect(normalizeQuery("$SOL staking OR ETF OR ETFs")).toBe("$SOL (staking OR ETF OR ETFs)");
    expect(normalizeQuery("bitcoin ETF OR \"spot ETF\" min_faves:50")).toBe("bitcoin (ETF OR \"spot ETF\") min_faves:50");
    expect(normalizeQuery("$SOL staking OR ETF min_faves:50 -giveaway")).toBe("$SOL (staking OR ETF) min_faves:50 -giveaway"); // filters apply to the whole search
    // other shapes keep their meaning, written out
    expect(normalizeQuery("$SOL staking OR $ETH staking")).toBe("($SOL staking) OR ($ETH staking)");
    expect(normalizeQuery("$SOL OR Solana")).toBe("$SOL OR Solana");
    expect(normalizeQuery("$SOL $JUP OR $BONK")).toBe("($SOL $JUP) OR $BONK");
    expect(normalizeQuery("from:aeyakovenko OR from:rajgokal")).toBe("from:aeyakovenko OR from:rajgokal");
    // nothing to do without a top-level OR (brackets and phrases are one term)
    expect(normalizeQuery("$SOL (staking OR ETF)")).toBe("$SOL (staking OR ETF)");
    expect(normalizeQuery("  \"OR gate\"   $X ")).toBe("\"OR gate\" $X");
    expect(topTerms('$SOL ("spot ETF" OR staking) "a b"')).toEqual(["$SOL", '("spot ETF" OR staking)', '"a b"']);
  });
  it("min_faves / min_retweets / min_replies are applied on our side (twitterapi.io returned 0-like posts for min_faves:50)", () => {
    const f = engagementFloor("$SOL (staking OR ETF) min_faves:50 min_retweets:5 since_time:1 -filter:replies");
    expect(f).toEqual({ likes: 50, reposts: 5, replies: 0 });
    expect(meetsFloor({ likes: 0, reposts: 9, replies: 0 }, f)).toBe(false);
    expect(meetsFloor({ likes: 50, reposts: 5, replies: 0 }, f)).toBe(true);
    expect(engagementFloor("$SOL")).toEqual({ likes: 0, reposts: 0, replies: 0 });
  });
  // Board #130: line breaks, long posts, pictures and video.
  it("keeps line breaks and long text; blank-line runs fold to one", () => {
    const long = "x".repeat(1_500);
    const p = cleanPost(raw(`GM\r\n\n\n\nline two   with  spaces \nline three https://t.co/abc\n${long}`));
    expect(p.text).toBe(`GM\n\nline two with spaces\nline three\n${long}`);
    expect(cleanPost(raw("y".repeat(3_000))).text).toHaveLength(TEXT_CAP);
    // spam across line breaks is still spam
    expect(isSpam(cleanPost(raw("Submit Your \n$SOL\n Wallet Address 👇\n\nOnly First 2k")))).toBe(true);
  });
  it("media: photos, video poster + an mp4 ≤ 1 Mbit/s, gifs; X hosts over https only, at most 4", () => {
    const m = mediaOf({ extendedEntities: { media: [
      { type: "photo", media_url_https: "https://pbs.twimg.com/media/HT0xpulXMAAkaic.jpg", original_info: { width: 1071, height: 716 } },
      { type: "video", media_url_https: "https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg", original_info: { width: 990, height: 812 }, video_info: { variants: [
        { content_type: "application/x-mpegURL", url: "https://video.twimg.com/a/pl/x.m3u8" },
        { bitrate: 256000, content_type: "video/mp4", url: "https://video.twimg.com/a/vid/328x270/s.mp4" },
        { bitrate: 832000, content_type: "video/mp4", url: "https://video.twimg.com/a/vid/438x360/m.mp4" },
        { bitrate: 2176000, content_type: "video/mp4", url: "https://video.twimg.com/a/vid/876x720/l.mp4" } ] } },
      { type: "animated_gif", media_url_https: "https://pbs.twimg.com/tweet_video_thumb/g.jpg", video_info: { variants: [{ bitrate: 0, content_type: "video/mp4", url: "https://video.twimg.com/tweet_video/g.mp4" }] } },
      { type: "photo", media_url_https: "https://evil.example/x.jpg" },
      { type: "photo", media_url_https: "http://pbs.twimg.com/media/x.jpg" },
    ] } });
    expect(m).toEqual([
      { type: "photo", url: "https://pbs.twimg.com/media/HT0xpulXMAAkaic.jpg", w: 1071, h: 716, video: null },
      { type: "video", url: "https://pbs.twimg.com/amplify_video_thumb/1/img/a.jpg", w: 990, h: 812, video: "https://video.twimg.com/a/vid/438x360/m.mp4" },
      { type: "gif", url: "https://pbs.twimg.com/tweet_video_thumb/g.jpg", w: null, h: null, video: "https://video.twimg.com/tweet_video/g.mp4" },
    ]);
    expect(mediaOf({})).toEqual([]);
    expect(cleanPost(raw("", 5000, { extendedEntities: { media: [{ type: "photo", media_url_https: "https://pbs.twimg.com/media/a.jpg" }] } })).media).toHaveLength(1);
  });
  it("velocity = posts per hour over the page's span", () => {
    const at = (m: number) => ({ createdAt: new Date(Date.UTC(2026, 8, 25, 12, m)).toISOString() });
    expect(velocity([at(0), at(15), at(30), at(60)])).toBe(4);
    expect(velocity([at(0), at(1)])).toBeNull();
  });
});
