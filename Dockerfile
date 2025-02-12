FROM node:17-slim
RUN apt-get update && apt-get install -y \
    netcat
WORKDIR /opt/app/
COPY package.json ./
RUN npm install
RUN npm prune
COPY . /opt/app
ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

CMD [ "npm", "start" ]