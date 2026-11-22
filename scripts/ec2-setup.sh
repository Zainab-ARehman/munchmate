#!/bin/bash
# One-time EC2 setup (Amazon Linux 2023). Paste as "User data" when launching the instance,
# or run once with: sudo bash ec2-setup.sh
set -e
dnf install -y nodejs unzip
mkdir -p /opt/munchmate/releases
cat > /opt/munchmate/deploy.sh <<'DEPLOY'
#!/bin/bash
# Deploys the latest successful build from S3. Usage: deploy.sh <bucket>
set -euo pipefail
BUCKET="$1"
KEY=$(aws s3 cp "s3://$BUCKET/builds/latest.txt" - | tr -d '\r\n')
REL="/opt/munchmate/releases/$(basename "$KEY" .zip)"
echo "Deploying $KEY"
rm -rf "$REL"; mkdir -p "$REL"
aws s3 cp "s3://$BUCKET/$KEY" /tmp/build.zip
unzip -oq /tmp/build.zip -d "$REL"
ln -sfn "$REL" /opt/munchmate/current
systemctl restart munchmate
sleep 3
curl -fsS http://localhost/health && echo && echo "Deployed $KEY successfully"
DEPLOY
chmod +x /opt/munchmate/deploy.sh
cat > /etc/systemd/system/munchmate.service <<'SERVICE'
[Unit]
Description=MunchMate
After=network.target
[Service]
WorkingDirectory=/opt/munchmate/current
Environment=PORT=80
ExecStart=/usr/bin/node server.js
Restart=always
User=root
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable munchmate
