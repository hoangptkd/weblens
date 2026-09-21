# syntax=docker/dockerfile:1.7

FROM maven:3.9.11-eclipse-temurin-21-alpine AS build
WORKDIR /workspace
COPY pom.xml ./
RUN --mount=type=cache,target=/root/.m2 mvn -B -q -DskipTests dependency:go-offline
COPY src ./src
RUN --mount=type=cache,target=/root/.m2 mvn -B -q -DskipTests package \
    && cp target/weblens-backend-*.jar /workspace/app.jar

FROM eclipse-temurin:21-jre-alpine
RUN addgroup -S weblens && adduser -S -G weblens weblens
WORKDIR /app
COPY --from=build --chown=weblens:weblens /workspace/app.jar ./app.jar
USER weblens
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "/app/app.jar"]
