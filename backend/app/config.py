from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7

    # Kept as a raw string and parsed manually rather than letting
    # pydantic auto-decode it as JSON (list-typed env vars caused a
    # production incident in ChatGini when the raw value wasn't valid JSON).
    cors_origins_raw: str = "http://localhost:5173"

    groq_api_key: str = ""

    @property
    def cors_origins(self) -> list[str]:
        if not self.cors_origins_raw:
            return ["http://localhost:5173"]
        return [origin.strip() for origin in self.cors_origins_raw.split(",") if origin.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
