declare module '*.svg' {
  const url: string
  export default url
}

declare module '*?worker&url' {
  const url: string
  export default url
}
