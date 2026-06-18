const test = require("node:test");
const assert = require("node:assert/strict");

const {
  parseFearGreedPosts,
  pickFearGreedPostForDate,
} = require("../scripts/koluniteFearGreedSync.js");

const SAMPLE_PAGE = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message">
    <div class="tgme_widget_message_bubble">
      <a class="tgme_widget_message_photo_wrap blured js-message_photo_wrap"
        href="https://t.me/kolunite_notice/7376"
        style="width:640px;background-image:url('https://cdn5.telesco.pe/file/fear-27.jpg')">
        <div class="tgme_widget_message_photo" style="padding-top:89.84375%"></div>
      </a>
      <div class="tgme_widget_message_text js-message_text" dir="auto">
        今日恐慌与贪婪指数：27<br/>等级：恐惧
      </div>
      <div class="tgme_widget_message_footer compact js-message_footer">
        <div class="tgme_widget_message_info short js-message_info">
          <span class="tgme_widget_message_meta">
            <a class="tgme_widget_message_date" href="https://t.me/kolunite_notice/7376">
              <time datetime="2026-04-19T00:05:13+00:00" class="time">00:05</time>
            </a>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message">
    <div class="tgme_widget_message_author accent_color">
      <a class="tgme_widget_message_owner_name" href="https://t.me/kolunite_notice">
        <span dir="auto">kolunite 公告群</span>
      </a>
    </div>
    <div class="tgme_widget_message_bubble">
      <a class="tgme_widget_message_photo_wrap blured js-message_photo_wrap"
        href="https://t.me/kolunite_notice/7377"
        style="width:640px;background-image:url('https://cdn5.telesco.pe/file/fear-29.jpg')">
        <div class="tgme_widget_message_photo" style="padding-top:89.84375%"></div>
      </a>
      <div class="tgme_widget_message_text js-message_text" dir="auto">
        今日恐慌与贪婪指数：29<br/>等级：恐惧 <br/><br/>说明：恐慌指数阈值为0-100。
      </div>
      <div class="tgme_widget_message_footer compact js-message_footer">
        <div class="tgme_widget_message_info short js-message_info">
          <span class="tgme_widget_message_meta">
            <a class="tgme_widget_message_date" href="https://t.me/kolunite_notice/7377">
              <time datetime="2026-04-20T00:05:12+00:00" class="time">00:05</time>
            </a>
          </span>
        </div>
      </div>
    </div>
  </div>
</div>
`;

test("parseFearGreedPosts extracts text image and source link from Telegram public page html", () => {
  const posts = parseFearGreedPosts(SAMPLE_PAGE);

  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1], {
    sourceUrl: "https://t.me/kolunite_notice/7377",
    imageUrl: "https://cdn5.telesco.pe/file/fear-29.jpg",
    message: "今日恐慌与贪婪指数：29\n等级：恐惧\n\n说明：恐慌指数阈值为0-100。",
    postedAt: "2026-04-20T00:05:12+00:00",
    channelName: "kolunite 公告群",
  });
});

test("pickFearGreedPostForDate returns the matching post for the target China date", () => {
  const posts = parseFearGreedPosts(SAMPLE_PAGE);
  const selected = pickFearGreedPostForDate(posts, "2026-04-20", "Asia/Shanghai");

  assert.equal(selected?.sourceUrl, "https://t.me/kolunite_notice/7377");
  assert.match(selected?.message || "", /今日恐慌与贪婪指数：29/);
});
