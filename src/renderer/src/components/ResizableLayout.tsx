import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'

interface Props {
  steps: React.ReactNode
  code: React.ReactNode
  explanation: React.ReactNode
  chat: React.ReactNode
}

/** Sizes in pixels; the code pane takes whatever width the side columns leave. */
const STEPS_WIDTH = 236
const STEPS_MIN = 160
const CODE_MIN = 320
const RIGHT_WIDTH = 380
const RIGHT_MIN = 280
const EXPLANATION_SHARE = '60'
const RIGHT_ROW_MIN = 120

/**
 * The walkthrough's three columns, plus the explanation/chat split in the right one. Every divider
 * drags, moves with the arrow keys when focused, and resets on double-click; sizes are remembered
 * in this browser's localStorage. Side columns keep their pixel width when the window resizes.
 */
export default function ResizableLayout({
  steps,
  code,
  explanation,
  chat
}: Props): React.JSX.Element {
  const columns = useDefaultLayout({
    id: 'walkthrough-columns',
    onlySaveAfterUserInteractions: true
  })
  const right = useDefaultLayout({ id: 'walkthrough-right', onlySaveAfterUserInteractions: true })
  return (
    <Group
      className="columns"
      orientation="horizontal"
      defaultLayout={columns.defaultLayout}
      onLayoutChanged={columns.onLayoutChanged}
    >
      <Panel
        id="steps"
        defaultSize={STEPS_WIDTH}
        minSize={STEPS_MIN}
        groupResizeBehavior="preserve-pixel-size"
      >
        {steps}
      </Panel>
      <Separator className="resize-handle" />
      <Panel id="code" minSize={CODE_MIN}>
        {code}
      </Panel>
      <Separator className="resize-handle" />
      <Panel
        id="right"
        defaultSize={RIGHT_WIDTH}
        minSize={RIGHT_MIN}
        groupResizeBehavior="preserve-pixel-size"
      >
        <Group
          className="right-column"
          orientation="vertical"
          defaultLayout={right.defaultLayout}
          onLayoutChanged={right.onLayoutChanged}
        >
          <Panel id="explanation" defaultSize={EXPLANATION_SHARE} minSize={RIGHT_ROW_MIN}>
            {explanation}
          </Panel>
          <Separator className="resize-handle" />
          <Panel id="chat" minSize={RIGHT_ROW_MIN}>
            {chat}
          </Panel>
        </Group>
      </Panel>
    </Group>
  )
}
