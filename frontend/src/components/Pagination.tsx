import { ChevronLeft, ChevronRight } from 'lucide-react'

interface NumberPaginationProps {
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  disabled?: boolean
  onPageChange: (page: number) => void
  onPageSizeChange: (pageSize: number) => void
}

export function NumberPagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  disabled = false,
  onPageChange,
  onPageSizeChange,
}: NumberPaginationProps) {
  const start = totalItems === 0 ? 0 : page * pageSize + 1
  const end = Math.min(totalItems, (page + 1) * pageSize)

  return (
    <nav className="pagination" aria-label="Phân trang">
      <p aria-live="polite">Hiển thị {start}–{end} trong {totalItems}</p>
      <label>
        <span>Mỗi trang</span>
        <select
          value={pageSize}
          disabled={disabled}
          onChange={(event) => onPageSizeChange(Number(event.target.value))}
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
        </select>
      </label>
      <div>
        <button
          type="button"
          aria-label="Trang trước"
          disabled={disabled || page <= 0}
          onClick={() => onPageChange(page - 1)}
        >
          <ChevronLeft aria-hidden="true" />
        </button>
        <span>Trang {totalPages === 0 ? 0 : page + 1} / {totalPages}</span>
        <button
          type="button"
          aria-label="Trang tiếp theo"
          disabled={disabled || page + 1 >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          <ChevronRight aria-hidden="true" />
        </button>
      </div>
    </nav>
  )
}

interface CursorPaginationProps {
  pageNumber: number
  itemCount: number
  totalItems: number
  canPrevious: boolean
  canNext: boolean
  disabled?: boolean
  onPrevious: () => void
  onNext: () => void
}

export function CursorPagination({
  pageNumber,
  itemCount,
  totalItems,
  canPrevious,
  canNext,
  disabled = false,
  onPrevious,
  onNext,
}: CursorPaginationProps) {
  return (
    <nav className="pagination pagination--cursor" aria-label="Phân trang kết quả scan">
      <p aria-live="polite">Trang dữ liệu {pageNumber} · hiển thị {itemCount} trong tổng số {totalItems}</p>
      <div>
        <button
          type="button"
          disabled={disabled || !canPrevious}
          onClick={onPrevious}
        >
          <ChevronLeft aria-hidden="true" />Trang trước
        </button>
        <button
          type="button"
          disabled={disabled || !canNext}
          onClick={onNext}
        >
          Trang tiếp theo<ChevronRight aria-hidden="true" />
        </button>
      </div>
    </nav>
  )
}
