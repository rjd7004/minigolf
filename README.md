# Mini Golf

A simple 2D minigolf game for the browser, in the style of GamePigeon mini golf. One hole, two players taking turns on the same screen. Built for phones.

## How to play

- Enter two names and tap **Tee off**.
- Touch anywhere on the course and **drag back** to aim. The dotted arrow shows where the ball will go; pull further for more power (the ring around the ball fills up). Let go to putt. A tiny drag cancels.
- Players alternate shots. Once a player sinks the ball, the other keeps going until they hole out.
- Hit the ball too hard and it lips out of the cup. Water is a one-stroke penalty and puts you back where you shot from. Sand slows the ball down. You pick up at 10 strokes.
- Lowest score wins. **Play again** swaps who tees off first.

## Running it

No build step and no dependencies: it's plain HTML, CSS and JavaScript.

- Open `index.html` in a browser, or
- serve the folder: `python3 -m http.server 8000`, then on a phone on the same Wi-Fi open `http://<your-computer-ip>:8000`.

To play on phones anywhere, host it as a static site, for example with GitHub Pages (Settings → Pages → deploy from branch, root folder). On iOS, "Add to Home Screen" runs it full screen.

## Files

- `index.html`: page layout (scoreboard, course canvas, menu and results screens)
- `style.css`: mobile-first styling
- `game.js`: course layout, physics, input, rendering and turn logic. The course is defined in the `COURSE` object at the top in a fixed 400×700 coordinate space, so holes are easy to edit or add.
