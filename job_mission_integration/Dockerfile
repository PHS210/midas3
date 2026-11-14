FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip

WORKDIR /app

# 미션 생성기가 Claude API를 부를 때 쓰는 Python 패키지
COPY requirements.txt ./
RUN pip install --no-cache-dir --break-system-packages -r requirements.txt

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8080

CMD ["npm", "start"]
