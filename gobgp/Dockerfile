FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install gobgp from Ubuntu packages
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        gobgpd \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create directory for configuration
RUN mkdir -p /etc

# Expose BGP port
EXPOSE 179

# Start gobgpd
CMD ["gobgpd", "-f", "/etc/gobgpd.conf"]