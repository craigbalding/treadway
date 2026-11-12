# Authoring this Treadway consumer

Use the local `.agents/skills/treadway-flows/SKILL.md` and its references.
Reuse calibrated domain keywords before adding an operation. Keep application
selectors, actual IDs, actor/revision checks and persistence observers here;
shared mechanics come from the installed Treadway package. Compose native Robot.

Run `python run.py check` before browser acceptance. Convert failures into small
contract regressions first; keep the original evidence. Then run the affected
suite with `CHROME_BIN` and `python run.py test --suite YOUR.robot`.
Imports/constructors and offline checks must not contact applications. Preserve
uncertain effects, avoid implicit action retries, and keep raw artifacts private.
