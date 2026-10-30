# Same pinned gateway binary; bake only the non-secret configuration template.
FROM ghcr.io/alexxit/go2rtc:1.9.14@sha256:675c318b23c06fd862a61d262240c9a63436b4050d177ffc68a32710d9e05bae
COPY deploy/live/go2rtc.yaml /etc/home-security-go2rtc.yaml
CMD ["go2rtc", "-config", "/etc/home-security-go2rtc.yaml"]
