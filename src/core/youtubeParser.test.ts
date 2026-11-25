import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildYouTubeEmbedUrl,
  CURATED_YOUTUBE_360,
  parseYouTubeVideoId,
} from './youtubeParser';

test('parses standard, short, embed, shorts, and raw YouTube IDs', () => {
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/watch?v=hEdzv7D4CbQ'),
    'hEdzv7D4CbQ',
  );
  assert.equal(
    parseYouTubeVideoId('https://youtu.be/2OEL4P1Rz04?t=45'),
    '2OEL4P1Rz04',
  );
  assert.equal(
    parseYouTubeVideoId('https://www.youtube.com/embed/v64KOxKVLVg'),
    'v64KOxKVLVg',
  );
  assert.equal(
    parseYouTubeVideoId('youtube.com/shorts/7AkbUfZjS5k'),
    '7AkbUfZjS5k',
  );
  assert.equal(parseYouTubeVideoId('hEdzv7D4CbQ'), 'hEdzv7D4CbQ');
});

test('rejects empty, malformed, or non-YouTube URLs', () => {
  assert.equal(parseYouTubeVideoId(''), null);
  assert.equal(parseYouTubeVideoId('   '), null);
  assert.equal(parseYouTubeVideoId('https://vimeo.com/123456789'), null);
  assert.equal(parseYouTubeVideoId('not-a-valid-id'), null);
});

test('buildYouTubeEmbedUrl builds safe playsinline embed URL', () => {
  const url = buildYouTubeEmbedUrl('hEdzv7D4CbQ', true);
  assert.ok(url.startsWith('https://www.youtube.com/embed/hEdzv7D4CbQ?'));
  assert.ok(url.includes('autoplay=1'));
  assert.ok(url.includes('playsinline=1'));
  assert.throws(() => buildYouTubeEmbedUrl('bad'));
});

test('curated 360 catalog contains valid IDs', () => {
  assert.ok(CURATED_YOUTUBE_360.length >= 4);
  for (const item of CURATED_YOUTUBE_360) {
    assert.equal(parseYouTubeVideoId(item.id), item.id);
  }
});
