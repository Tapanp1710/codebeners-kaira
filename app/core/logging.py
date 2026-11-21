import logging

_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(getattr(h, "_kaira", False) for h in root.handlers):
        root.setLevel(level)
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(_FORMAT))
    handler._kaira = True  # type: ignore[attr-defined]
    root.addHandler(handler)
    root.setLevel(level)
