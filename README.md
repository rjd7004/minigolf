# Mini Golf

A simple 2D minigolf game for the browser, in the style of GamePigeon mini golf. One hole, two players. Built for phones.

## Two ways to play

**Play a friend (each on your own phone).** Enter your name, take your first shot, then tap **Send link** and text it to your friend. When they open it, they type their name, watch your shot replay, and take theirs. Then they send a link back. Keep trading links until you've both holed out.

The whole game is stored in the link itself (the part after `#`), so there's no server or account. Each phone remembers the newest turn it has seen, so reopening an old link won't let anyone retake a shot.

**Same phone.** Enter both names and pass the phone back and forth.

## How to play

- Touch anywhere on the course and **drag back** to aim. The dotted arrow shows where the ball will go; pull further for more power (the ring around the ball fills up). Let go to putt. A tiny drag cancels.
- Players alternate shots. Once a player sinks the ball, the other keeps going until they hole out.
- Hit the ball too hard and it lips out of the cup. Water is a one-stroke penalty and puts you back where you shot from. Sand slows the ball down. You pick up at 10 strokes.
- Lowest score wins. **Play again** swaps who tees off first.

## Running it

No build step and no dependencies: it's plain HTML, CSS and JavaScript.

- Open `index.html` in a browser, or
- serve the folder: `python3 -m http.server 8000`, then on a phone on the same Wi-Fi open `http://<your-computer-ip>:8000`.

Links only work for your friend if the game is hosted at a public address. The easiest option is GitHub Pages: in the repo go to **Settings → Pages**, choose **Deploy from a branch**, pick `main` and `/ (root)`, and save. The game will be at `https://rjd7004.github.io/minigolf/`. The link-preview image in `index.html` points at that address; update the `og:image` URL if you host it somewhere else.

On iOS, "Add to Home Screen" runs it full screen.

## Versions

The version shows in the bottom-right corner. It's set in `index.html`: when releasing, bump the label and the two `?v=` links to the stylesheet and script (the `?v=` makes phones fetch the new files instead of a cached copy).

- v1.4: slightly easier drop-ins, especially near the edge of the cup
- v1.3: lower max power, faster early slowdown, smaller and tougher cup, new drop-in animation
- v1.2: version label
- v1.1: smoother roll-out, ball can ride the rim of the cup
- v1.0: first release (same-phone and play-a-friend link modes)

## Files

- `index.html`: page layout (scoreboard, course canvas, menu and results screens)
- `style.css`: mobile-first styling
- `game.js`: course layout, physics, input, rendering, turn logic and the link encoding. The course is defined in the `COURSE` object at the top in a fixed 400×700 coordinate space, so holes are easy to edit or add.
- `preview.png`, `icon.png`: link preview image and home-screen icon
